// Offline checks for the 50-project cap: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_CAP, capLine, capNotice, capProblems, isFull } from './creditcards-cap.mjs';

const projects = (approved, other = 3) => [
  ...Array.from({ length: approved }, (_, i) => ({ id: `a${i}`, status: 'approved', added: i ? '2026-10-12' : '2026-09-24' })),
  ...Array.from({ length: other }, (_, i) => ({ id: `r${i}`, status: 'rejected' })),
];

test('the cap: quiet below 50, a reminder at 50, a refusal past it', () => {
  assert.equal(PROJECT_CAP, 50);
  assert.equal(capNotice(projects(49)), null);
  assert.deepEqual(capProblems(projects(49)), []);
  assert.match(capNotice(projects(50)), /reached 50 projects.*issues\/101/);
  assert.equal(capNotice(projects(50), '2026-10-12'), null, 'quiet once the freeze is recorded');
  assert.deepEqual(capProblems(projects(50)), [], '50 is allowed');
  assert.match(capProblems(projects(51))[0], /51 approved projects; .*capped at the first 50/);
  assert.equal(capNotice(projects(10, 60)), null, 'rejected and pending entries never count');
});

test('the places-left line under the title', () => {
  assert.equal(capLine(projects(48)), '2 places left.');
  assert.equal(capLine(projects(49)), '1 place left.');
  assert.equal(capLine(projects(50)), 'Collected 24 Sept to 12 Oct 2026.', 'once full, the span the 50 came in over');
  assert.equal(isFull(projects(49)), false);
  assert.equal(isFull(projects(50)), true);
});
