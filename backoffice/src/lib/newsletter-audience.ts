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
    email: string;
    label: string;
    first_name: string;
}

type Fragment = { group: string; sql: string; binds?: unknown[] };

const SOURCE_KINDS = new Set(["shopify", "stripe", "stripe_connect", "lodgify", "eupago"]);
const DEST_KINDS = new Set(["invoicexpress", "moloni", "vendus"]);
const SUB_STATES = new Set(["active", "trialing", "past_due", "canceled", "unpaid", "incomplete"]);
const PLANS = new Set(["monthly", "annual"]);

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
        return {
            group: "subscription",
            sql: `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = ?)`,
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

export async function resolveAudience(db: any, keys: string[]): Promise<Recipient[]> {
    const { sql, binds } = audienceQuery(keys);
    const { results } = await db.prepare(sql).bind(...binds).all();
    const seen = new Set<string>();
    const out: Recipient[] = [];
    for (const r of (results ?? []) as any[]) {
        const email = String(r.email ?? "").trim().toLowerCase();
        // One account per address. Two accounts sharing a mailbox is rare and
        // legitimate; the same person receiving the same newsletter twice is
        // neither.
        if (!email || seen.has(email)) continue;
        seen.add(email);
        const label = String(r.label ?? email);
        out.push({ user_id: String(r.user_id), email, label, first_name: firstNameOf(r.name, label) });
    }
    return out;
}
