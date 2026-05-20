/**
 * One-off test sender for incident emails. Renders the chosen template and
 * ships via Resend so you can eyeball it on a real mobile client (Gmail
 * Android dark mode is the picky one).
 *
 * Usage:
 *   RESEND_API_KEY=re_xxx npx tsx scripts/send-test-incident-email.ts <recipient> [kind]
 *
 * Defaults:
 *   kind      = webhook_invalid_signature
 *   from      = Rioko <rioko-devmode@kapta.pt>  (override with RESEND_FROM_EMAIL)
 */

import { Resend } from "resend";
import {
  renderIncidentTemplate,
  type IncidentKind,
  type IncidentTemplateInput,
} from "../src/services/email-templates.js";

const KINDS: IncidentKind[] = [
  "auth_failure_destination",
  "auth_failure_source",
  "destination_reject",
  "normalize_fail",
  "nif_invalid",
  "subscription_inactive",
  "queue_retry_exhausted",
  "webhook_invalid_signature",
];

async function main() {
  const recipient = process.argv[2];
  const kindArg = (process.argv[3] ?? "webhook_invalid_signature") as IncidentKind;

  if (!recipient) {
    console.error("Usage: npx tsx scripts/send-test-incident-email.ts <recipient> [kind]");
    console.error(`Available kinds: ${KINDS.join(", ")}`);
    process.exit(1);
  }
  if (!KINDS.includes(kindArg)) {
    console.error(`Unknown kind: ${kindArg}`);
    console.error(`Available: ${KINDS.join(", ")}`);
    process.exit(1);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY env var required.");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const input: IncidentTemplateInput = {
    merchantName: "Pedro Porto",
    connectionLabel: "stripe → invoicexpress",
    occurrences: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    summary: "Test render — verifying mobile dark-mode title visibility.",
    severity: "critical",
    affectedIds: ["test_order_001", "test_order_002"],
    dashboardUrl: "https://rioko.online",
  };

  const { subject, html } = renderIncidentTemplate(kindArg, input);

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "rioko-devmode@kapta.pt";
  const fromName = process.env.RESEND_FROM_NAME ?? "Rioko";

  console.log(`Sending [${kindArg}] → ${recipient} (from ${fromName} <${fromEmail}>)`);
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: [recipient],
    subject: `[TEST] ${subject}`,
    html,
  });

  if (error) {
    console.error("Resend error:", error);
    process.exit(1);
  }
  console.log(`OK · id=${data?.id}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
