// Regression: the scan path passed as the first argument must be the one used.
// #133 added --prev and its filter skipped argv[0] whenever --prev was absent,
// so the weekly CI bake (`node scripts/axbeat-data.mjs ..`) ignored its path,
// fell back to ../ax-audit and died with "no scan found" (9 Nov 2026 scan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'axbeat-data.mjs');

// A fake ax-audit checkout whose scan names a targets file that is not there.
// The script dies reading it, before it writes anything, and the error names
// this directory: proof the explicit path was honoured, not the default.
function fakeAudit() {
  const dir = mkdtempSync(path.join(tmpdir(), 'axbeat-args-'));
  mkdirSync(path.join(dir, 'results'));
  writeFileSync(
    path.join(dir, 'results', 'l2-top22-latest.json'),
    JSON.stringify({ scannedAt: '2026-11-09T00:00:00Z', targetsFile: 'targets/missing.json', results: [] }),
  );
  return dir;
}

for (const args of [(d) => [d], (d) => [d, '--prev', 'axbeat.html'], (d) => ['--prev', 'axbeat.html', d]]) {
  test(`scan path is honoured: ${args('<dir>').join(' ')}`, () => {
    const dir = fakeAudit();
    const r = spawnSync(process.execPath, [script, ...args(dir)], { cwd: root, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /no scan found/);
    assert.match(r.stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
