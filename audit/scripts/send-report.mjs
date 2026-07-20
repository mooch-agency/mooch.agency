// Sends the audit result to the lead via Resend: lean HTML body (render-email.mjs)
// with the full report PDF attached, cc'd to hey@ so Mooch keeps a copy (story 16).
//
// Env: RESEND_API_KEY (Keystore > Resend). From/cc are on-brand mooch.agency
// addresses (verified sending domain). Resend also confirms the address is real,
// which is the last line of the junk defence.
//
// Usage:
//   node send-report.mjs <record.json> <pdfPath> [--dry-run]
// --dry-run prints the subject/recipients/size and does NOT send. Always dry-run
// first when testing so no real inbox is hit.

import { renderEmail } from "../report/render-email.mjs";
import { readFileSync } from "fs";
import { basename } from "path";
import { pathToFileURL } from "url";

const FROM = process.env.AUDIT_FROM || "Mooch <hey@mooch.agency>";
const CC = process.env.AUDIT_CC || "hey@mooch.agency";

function ukDate(d = new Date()) {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// record + pdfPath -> sends (or, dryRun, returns the payload without sending).
export async function sendReport(record, pdfPath, { dryRun = false } = {}) {
  const to = record.email;
  if (!to) throw new Error("record has no email");
  const { subject, html } = renderEmail(record, ukDate());
  const pdf = readFileSync(pdfPath);
  const payload = {
    from: FROM,
    to: [to],
    cc: [CC],
    subject,
    html,
    attachments: [
      { filename: basename(pdfPath), content: pdf.toString("base64") },
    ],
  };

  if (dryRun) {
    return {
      dryRun: true,
      from: FROM,
      to,
      cc: CC,
      subject,
      pdfBytes: pdf.length,
      htmlBytes: Buffer.byteLength(html),
    };
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return { sent: true, id: data.id, to, subject };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [recordPath, pdfPath] = args.filter((a) => !a.startsWith("--"));
  if (!recordPath || !pdfPath) {
    console.error("usage: node send-report.mjs <record.json> <pdfPath> [--dry-run]");
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  sendReport(record, pdfPath, { dryRun })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
