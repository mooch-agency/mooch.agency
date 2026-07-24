// Turns a pipeline record (audit/scripts/run-pipeline.mjs output JSON) into the
// branded HTML report and a print-quality PDF.
//
// PDF approach: puppeteer-core page.pdf() driving the same local Chrome the
// pipeline already uses. This deviates from Fortress's client-side jspdf/html2pdf
// (which is browser-only and won't run in the headless runner); page.pdf() is
// headless-native, needs no new dependency, and renders true print CSS. The
// report HTML is self-contained so a cold forwarded reader needs no login.
//
// Usage:
//   node build-report.mjs <record.json> [out_dir]
// Programmatic:
//   import { buildReport } from './build-report.mjs'
//   const { htmlPath, pdfPath, thin } = await buildReport(record, outDir)

import { renderReport } from "./render-report.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// UK long date, e.g. "20 July 2026". Kept out of render-report.mjs so the
// renderer stays deterministic and unit-testable without a clock.
function ukDate(d = new Date()) {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function slugFor(record) {
  const host = (() => {
    try {
      return new URL(record.site).host.replace(/^www\./, "");
    } catch {
      return "site";
    }
  })();
  const id = record.auditId || record.tag || "audit";
  return `${host.replace(/[^a-z0-9]+/gi, "-")}_${id}`;
}

// record -> { html, thin, findingCount, weight }, written to <outDir>/<slug>.html
export function writeHtml(record, outDir) {
  mkdirSync(outDir, { recursive: true });
  const out = renderReport(record, ukDate());
  const htmlPath = join(outDir, `${slugFor(record)}.html`);
  writeFileSync(htmlPath, out.html);
  return { ...out, htmlPath };
}

// Renders the HTML to PDF via headless Chrome. Lazy-imports puppeteer-core so
// writeHtml() alone (used in tests) needs no browser.
export async function htmlToPdf(html, pdfPath) {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    // --no-sandbox is required in CI (GitHub Actions runner has no configured
    // SUID sandbox helper). Harmless on local Chrome. Same on every launch site.
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    // waitUntil networkidle0 lets the Instrument Serif webfont load before print.
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
    });
  } finally {
    await browser.close().catch(() => {});
  }
  return pdfPath;
}

export async function buildReport(record, outDir) {
  const { html, htmlPath, thin, findingCount, weight } = writeHtml(
    record,
    outDir
  );
  const pdfPath = htmlPath.replace(/\.html$/, ".pdf");
  await htmlToPdf(html, pdfPath);
  return { htmlPath, pdfPath, thin, findingCount, weight };
}

// CLI entrypoint. pathToFileURL handles spaces in the path (percent-encoding),
// which a raw `file://${argv[1]}` comparison would miss.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [recordPath, outDir = dirname(process.argv[1]) + "/out"] =
    process.argv.slice(2);
  if (!recordPath) {
    console.error("usage: node build-report.mjs <record.json> [out_dir]");
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const res = await buildReport(record, outDir);
  console.log(JSON.stringify(res, null, 2));
}
