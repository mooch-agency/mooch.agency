// Ratchet, not a style rule: an inline setTimeout whose callback writes
// textContent is the exact shape that stuck the copy button on "Copied" (the
// second click captured the transient label as the one to restore, and the
// timers overlapped). Widget timing now lives in state.js, whose timers are
// cleared on re-entry and guarded by a generation token, so a page should not
// grow a new inline one. The allowlist pins today's remaining instances and
// only ever shrinks: fix one, lower its number here in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED = {
  'paulgraham.html': 5,    // desktop and mobile Copy restores and dial count-up (PR 5 territory)
  'ready.html': 1,         // countUp's end-state safety snap, harmless by design
  'stagger-tuner.html': 1, // internal tuning page, not shipped
  'unblocked.html': 2,     // confirmOn: the correct pattern, kept page-local on purpose
};

function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// A setTimeout call whose next 400 characters assign to textContent. A
// heuristic, deliberately cheap: it is a tripwire for the known failure
// shape, not a parser.
function countTimerTextWrites(html) {
  let n = 0;
  for (const js of inlineScripts(html)) {
    const re = /setTimeout\s*\(/g;
    let m;
    while ((m = re.exec(js))) {
      if (/\.textContent\s*=/.test(js.slice(m.index, m.index + 400))) n++;
    }
  }
  return n;
}

const pages = [
  ...readdirSync(root).filter((f) => f.endsWith('.html')),
  ...readdirSync(path.join(root, 'prompts')).map((f) => path.join('prompts', f)),
].filter((f) => f.endsWith('.html'));

test('no new inline setTimeout writes textContent outside state.js', () => {
  const problems = [];
  for (const rel of pages) {
    const n = countTimerTextWrites(readFileSync(path.join(root, rel), 'utf8'));
    const cap = ALLOWED[rel] || 0;
    if (n > cap) {
      problems.push(`${rel}: ${n} inline setTimeout textContent writes, allowed ${cap}. Use state.js for widget timing.`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the allowlist only shrinks: a fixed page lowers its number here', () => {
  for (const [rel, cap] of Object.entries(ALLOWED)) {
    const n = countTimerTextWrites(readFileSync(path.join(root, rel), 'utf8'));
    assert.equal(n, cap, `${rel} now has ${n} (allowlist says ${cap}): update the allowlist downward`);
  }
});
