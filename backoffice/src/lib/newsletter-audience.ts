import { CUSTOMERS, HAS_PIPE, GATE_OPEN } from "./admin-stats-sql";
import { ACCOUNT_LABEL_SQL } from "./labels";

/**
 * Who a newsletter goes to.
 *
 * The filters an operator ticks on the page are the whole feature, so they are
 * one composable expression here rather than a query per campaign: chips are
 * combined OR inside a group and AND across groups, which is how someone
 * actually thinks about it ("Shopify or Stripe, that never paid").
 *
 * Two rules this file exists to hold:
 *
 * - `is_inactive` is NOT filtered out. A parked account is dormant by decision
 *   and receives no WARNINGS, which is a different thing from hearing nothing
 *   ever again. That distinction is written down in five places — migration
 *   0046, inactive-accounts.ts, incidents.ts, and both messages files, where it
 *   is shown to the operator as "only receives newsletters" — so a filter that
 *   quietly dropped them would make the product lie to its own admin. It is
 *   offered as a deliberate chip instead.
 * - Nothing from the request reaches the SQL. Keys are looked up in a table and
 *   their parameters checked against an allow-list; an unknown key is dropped,
 *   never interpolated. The audience is chosen by an admin, but an admin typing
 *   into a URL is still the outside of a trust boundary.
 *
 * The base set is CUSTOMERS — real accounts, not us and not invited seats — plus
 * an address to send to. Every filter narrows from there.
 */

export interface Recipient {
    user_id: string;
    /** The customer number (0058). What a campaign is filed under afterwards. */
    client_code: string | null;
    email: string;
    label: string;
    first_name: string;
}

type Fragment = { group: string; sql: string; binds?: unknown[] };

const SOURCE_KINDS = new Set(["shopify", "stripe", "stripe_connect", "lodgify", "eupago"]);
const DEST_KINDS = new Set(["invoicexpress", "moloni", "vendus"]);
const SUB_STATES = new Set(["active", "trialing", "past_due", "canceled", "unpaid", "incomplete"]);
/** The states the gate refuses. Same list as GATE_OPEN's NOT IN. */
const DEAD_STATES = new Set(["past_due", "canceled", "unpaid", "incomplete"]);
const PLANS = new Set(["monthly", "annual"]);
/** A user id as a `user:` pick carries it. Anything else never reaches the SQL. */
const PICK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The shape the worker re-checks before it creates a contact. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The legacy Shopify→InvoiceXpress pipe has no `connections` row — it is
 *  columns on `integrations`. Both halves of that pair have to look there too,
 *  or the oldest clients on the platform fall out of their own segment. */
const LEGACY_PIPE = `EXISTS (SELECT 1 FROM integrations i WHERE i.user_id = u.id AND i.shopify_domain IS NOT NULL)`;

const FIXED: Record<string, Fragment> = {
    never_paid: {
        group: "money",
        sql: `NOT EXISTS (SELECT 1 FROM billing_events b WHERE b.user_id = u.id AND b.type = 'invoice.paid')`,
    },
    has_paid: {
        group: "money",
        sql: `EXISTS (SELECT 1 FROM billing_events b WHERE b.user_id = u.id AND b.type = 'invoice.paid')`,
    },
    legacy_price: {
        group: "money",
        sql: `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND COALESCE(s.legacy_price, 0) = 1)`,
    },
    blocked: { group: "gate", sql: `NOT ${GATE_OPEN("u")}` },
    allowed: { group: "gate", sql: GATE_OPEN("u") },
    no_integration: { group: "setup", sql: `NOT ${HAS_PIPE("u")}` },
    has_integration: { group: "setup", sql: HAS_PIPE("u") },
    never_issued: {
        group: "setup",
        sql: `${HAS_PIPE("u")} AND NOT EXISTS (
                SELECT 1 FROM processed_orders p WHERE p.user_id = u.id AND p.invoice_id IS NOT NULL)`,
    },
    registered: { group: "profile", sql: `COALESCE(u.registration_completed, 0) = 1` },
    not_registered: { group: "profile", sql: `COALESCE(u.registration_completed, 0) = 0` },
    inactive: { group: "profile", sql: `COALESCE(u.is_inactive, 0) = 1` },
    not_inactive: { group: "profile", sql: `COALESCE(u.is_inactive, 0) = 0` },
};

/** A key with a parameter, checked against its allow-list. Returns null for
 *  anything unrecognised, which the composer then drops. */
function parameterised(key: string): Fragment | null {
    const [head, ...rest] = key.split(":");
    const arg = rest.join(":");
    if (!arg) return null;

    if (head === "source" && SOURCE_KINDS.has(arg)) {
        const conn = `EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.source_kind = ?)`;
        return {
            group: "source",
            sql: arg === "shopify" ? `(${conn} OR ${LEGACY_PIPE})` : conn,
            binds: [arg],
        };
    }
    if (head === "dest" && DEST_KINDS.has(arg)) {
        const conn = `EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.destination_kind = ?)`;
        return {
            group: "destination",
            sql: arg === "invoicexpress" ? `(${conn} OR ${LEGACY_PIPE})` : conn,
            binds: [arg],
        };
    }
    if (head === "sub" && SUB_STATES.has(arg)) {
        // A dead status on ONE connection is not a dead account. Since 0044 an
        // account holds a row per connection, and the platform manufactures the
        // mixture itself: retireConnectionKey() cancels the old row the moment a
        // subscription is moved to the right pair, so an account that is paying
        // today carries a 'canceled' row for ever after.
        //
        // Ticking "Cancelada" to write a win-back would then mail "lamentamos que
        // tenhas saído" to a paying client. A closed state has to mean the
        // account is actually closed, so it carries the gate with it. The open
        // states stay existential, because one live connection IS an active
        // account.
        const closed = DEAD_STATES.has(arg);
        return {
            group: "subscription",
            sql: closed
                ? `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = ?) AND NOT ${GATE_OPEN("u")}`
                : `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = ?)`,
            binds: [arg],
        };
    }
    if (head === "plan" && PLANS.has(arg)) {
        return {
            group: "subscription",
            sql: `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.plan = ?)`,
            binds: [arg],
        };
    }
    if (head === "early_bird_ending") {
        const days = Number(arg);
        if (!Number.isInteger(days) || days < 1 || days > 365) return null;
        // A window over days, not an access decision, so the date-only
        // comparison of TRIALS_ENDING is the right one here — an early bird
        // whose trial ends later today still belongs in "ends within N days".
        return {
            group: "money",
            sql: `EXISTS (
                    SELECT 1 FROM subscriptions s
                    WHERE s.user_id = u.id
                      AND s.status = 'trialing'
                      AND s.stripe_subscription_id IS NULL
                      AND COALESCE(s.early_bird, 0) = 1
                      AND s.trial_end IS NOT NULL
                      AND substr(s.trial_end, 1, 10) >= date('now')
                      AND substr(s.trial_end, 1, 10) <= date('now', ?))`,
            binds: [`+${days} day`],
        };
    }
    return null;
}

export function fragmentFor(key: string): Fragment | null {
    return FIXED[key] ?? parameterised(key);
}

/** Every key the page may offer, so the UI cannot drift from what works. */
export const FILTER_KEYS: string[] = [
    ...[...SOURCE_KINDS].map((k) => `source:${k}`),
    ...[...DEST_KINDS].map((k) => `dest:${k}`),
    ...[...SUB_STATES].map((k) => `sub:${k}`),
    ...[...PLANS].map((k) => `plan:${k}`),
    "early_bird_ending:30",
    ...Object.keys(FIXED),
];

/**
 * The audience as one query.
 *
 * Keys are grouped by the group their fragment declares: OR within a group, AND
 * between groups. An empty list is every customer with an address, which is a
 * legitimate choice and not an error — the page states the count before anyone
 * can send to it.
 */
export function audienceQuery(keys: string[]): { sql: string; binds: unknown[] } {
    const groups = new Map<string, { sql: string[]; binds: unknown[] }>();

    // Clients picked by hand travel as `user:<id>`, all of them one group, bound
    // as a single JSON array so a long pick cannot run into D1's cap on bound
    // parameters. A pick that fails the id shape still opens the group: a
    // malformed pick must select nobody, never fall through to everyone.
    const picks = keys.filter((k) => k.startsWith("user:"));
    if (picks.length) {
        const ids = picks.map((k) => k.slice(5)).filter((id) => PICK_ID.test(id));
        groups.set("pick", { sql: ["(u.id IN (SELECT value FROM json_each(?)))"], binds: [JSON.stringify(ids)] });
    }

    for (const key of keys) {
        const f = fragmentFor(key);
        if (!f) continue;
        const g = groups.get(f.group) ?? { sql: [], binds: [] };
        g.sql.push(`(${f.sql})`);
        g.binds.push(...(f.binds ?? []));
        groups.set(f.group, g);
    }

    const where: string[] = [];
    const binds: unknown[] = [];
    for (const g of groups.values()) {
        where.push(`(${g.sql.join(" OR ")})`);
        binds.push(...g.binds);
    }

    const sql = `
      SELECT u.id AS user_id,
             u.client_code AS client_code,
             u.email AS email,
             ${ACCOUNT_LABEL_SQL("u")} AS label,
             u.name AS name
      FROM (${CUSTOMERS}) u
      WHERE u.email IS NOT NULL
        AND u.email LIKE '%_@_%._%'
        ${where.length ? `AND ${where.join(" AND ")}` : ""}
      ORDER BY label COLLATE NOCASE ASC
    `;
    return { sql, binds };
}

/** First name for the greeting, by the same rule pausedNoticeEmail uses. */
export function firstNameOf(name: unknown, label: string): string {
    const s = String(name ?? "").trim() || label.trim();
    return s ? s.split(/\s+/)[0] : "";
}

/** Addresses typed by hand, as `email:<address>`: valid ones only, lowercased, once. */
export function manualEmailsOf(keys: string[]): string[] {
    return [...new Set(keys
        .filter((k) => k.startsWith("email:"))
        .map((k) => k.slice(6).trim().toLowerCase())
        .filter((e) => EMAIL_SHAPE.test(e)))];
}

export async function resolveAudience(db: any, keys: string[]): Promise<Recipient[]> {
    const rest = keys.filter((k) => !k.startsWith("email:"));
    const typed = rest.length !== keys.length;
    const chosen = rest.some((k) => k.startsWith("user:") || fragmentFor(k) !== null);

    // Typed addresses with nothing else chosen mean "these addresses", never
    // "every customer plus these": the empty filter is everyone, and typing an
    // email, even an invalid one, must not widen a send to the whole list.
    let results: unknown[] = [];
    if (chosen || !typed) {
        const { sql, binds } = audienceQuery(rest);
        results = (await db.prepare(sql).bind(...binds).all()).results ?? [];
    }
    // Whoever pressed "Cancelar subscrição" is out of every newsletter, picked by
    // hand or typed in included. Starting `seen` with them drops them from both
    // loops below without a second rule. One small table, read whole.
    const optedOut = ((await db.prepare("SELECT email FROM newsletter_optouts").bind().all()).results ?? [])
        .map((r: any) => String(r.email ?? "").trim().toLowerCase());
    const seen = new Set<string>(optedOut);
    const out: Recipient[] = [];
    for (const r of (results ?? []) as any[]) {
        const email = String(r.email ?? "").trim().toLowerCase();
        // One account per address. Two accounts sharing a mailbox is rare and
        // legitimate; the same person receiving the same newsletter twice is
        // neither.
        if (!email || seen.has(email)) continue;
        seen.add(email);
        const label = String(r.label ?? email);
        out.push({
            user_id: String(r.user_id),
            client_code: r.client_code ? String(r.client_code) : null,
            email, label, first_name: firstNameOf(r.name, label),
        });
    }
    for (const email of manualEmailsOf(keys)) {
        if (seen.has(email)) continue;
        seen.add(email);
        // Not an account: no id, no customer number, no name to greet by.
        out.push({ user_id: "", client_code: null, email, label: email, first_name: "" });
    }
    return out;
}
