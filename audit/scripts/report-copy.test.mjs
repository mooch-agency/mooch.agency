// Guards the copy that changes with the thin-report floor. No browser: the
// renderer returns an HTML string, so these are plain string assertions.
//   node --test scripts/report-copy.test.mjs
//
// The regression: the closer BODY branched on `thin` from the start, the closer
// TITLE never did. A good-shape report closed with "Want these fixed" above a
// paragraph saying the pages were clean, pointing at a findings list that
// variant never prints (propstrata, aud_ms5sy6lmrhf0mu).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../report/render-report.mjs';

const finding = (severity) => ({
  url: 'https://example.com/pricing',
  quote: 'Plans from £19 a month',
  severity,
  category: 'pricing',
  issue: 'Two different prices for the same plan.',
  gate: 'pass',
});

const record = (findings) => ({
  site: 'https://example.com/',
  auditId: 'aud_test',
  findings,
  picker: { pages_used: ['https://example.com/', 'https://example.com/pricing'] },
  coverage: { notes: [] },
  link_check: { broken: [] },
});

// Two lows total weight 2, under THIN_FLOOR_WEIGHT, so this is the good-shape
// variant even though the gate passed real findings. Exactly Uche's case.
test('good-shape report never asks to fix findings it did not print', () => {
  const out = renderReport(record([finding('low'), finding('low')]), '29 July 2026');
  assert.equal(out.thin, true);
  assert.ok(!out.html.includes('Want these fixed'), 'closer must not say "these" with no list above it');
  assert.match(out.html, /Want your whole site read the same way\?/);
});

test('findings report still asks to fix them', () => {
  const out = renderReport(record([finding('high')]), '29 July 2026');
  assert.equal(out.thin, false);
  assert.match(out.html, /Want these fixed, or the whole site read\?/);
});
