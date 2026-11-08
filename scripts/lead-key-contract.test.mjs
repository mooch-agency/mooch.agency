// The lead forms and the lead endpoints were built in parallel and first
// shipped with different names for the same field (`key` on the page,
// `idempotency_key` on the server), which silently disabled duplicate
// protection. This pins both sides to one name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FIELD = 'idempotency_key';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const pairs = [
  { page: 'index.html', endpoint: 'api/audit.js', path: '/api/audit' },
  { page: 'axbeat.html', endpoint: 'api/axbeat-lead.js', path: '/api/axbeat-lead' },
];

for (const { page, endpoint, path } of pairs) {
  test(`${page} sends ${FIELD} to ${path}, and ${endpoint} reads it`, () => {
    const html = read(page);
    const at = html.indexOf(`"${path}"`);
    assert.ok(at !== -1, `${page} no longer posts to ${path}`);
    const call = html.slice(at, at + 200);
    assert.match(call, new RegExp(`\\b${FIELD}:\\s*m\\.key\\(\\)`), `${page} must send the form key as ${FIELD}`);
    assert.match(read(endpoint), new RegExp(`body\\.${FIELD}\\b`), `${endpoint} must read body.${FIELD}`);
  });
}
