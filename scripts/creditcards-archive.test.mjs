// Offline checks for the Wayback archive step: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARCHIVE_PER_RUN, archiveProblems, archiveProjects } from './creditcards-archive.mjs';

const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const project = (i, over = {}) => ({ id: `p${i}`, name: `P${i}`, url: `https://p${i}.example/`, status: 'approved', added: '2026-10-01', ...over });

test('uses a snapshot from after listing, saves a fresh one otherwise, a few a run', async () => {
  const saved = [];
  const fetchImpl = async (url) => {
    if (url.startsWith('https://archive.org/wayback/available')) {
      const target = decodeURIComponent(url.split('url=')[1]);
      // p0 has a recent snapshot, p1 only one from before it was listed.
      if (target.includes('p0.')) return json({ archived_snapshots: { closest: { available: true, status: '200', timestamp: '20261005120000', url: `http://web.archive.org/web/20261005120000/${target}` } } });
      if (target.includes('p1.')) return json({ archived_snapshots: { closest: { available: true, status: '200', timestamp: '20250101000000', url: 'http://web.archive.org/web/20250101000000/x' } } });
      return json({ archived_snapshots: {} });
    }
    if (url.startsWith('https://web.archive.org/save/')) {
      const target = url.slice('https://web.archive.org/save/'.length);
      saved.push(target);
      if (target.includes('p3.')) throw new Error('timeout');
      return { ok: false, status: 302, headers: new Headers({ location: `https://web.archive.org/web/20261012101500/${target}` }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const projects = [...Array.from({ length: 7 }, (_, i) => project(i)), project(9, { status: 'rejected' })];
  const { archived, left } = await archiveProjects(projects, fetchImpl, () => {}, () => {});
  assert.equal(archived, ARCHIVE_PER_RUN - 1, 'p3 failed and waits for the next run');
  assert.equal(left, 3);
  assert.equal(projects[0].archive, 'https://web.archive.org/web/20261005120000/https://p0.example/');
  assert.equal(projects[1].archive, 'https://web.archive.org/web/20261012101500/https://p1.example/', 'a pre-listing snapshot is not the project');
  assert.equal(projects[3].archive, undefined);
  assert.equal(projects[5].archive, undefined, 'past the per-run limit');
  assert.ok(!saved.some((u) => u.includes('p9.')), 'rejected entries are never archived');
  assert.deepEqual(archiveProblems(projects), []);
});

test('archive problems: a bad link, or offline with nowhere to send people', () => {
  assert.match(archiveProblems([project(1, { archive: 'https://example.com' })])[0], /web\.archive\.org/);
  assert.match(archiveProblems([project(1, { offline: true })])[0], /marked offline but has no archive/);
});
