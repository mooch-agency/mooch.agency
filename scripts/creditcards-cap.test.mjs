// Offline checks for the 50-project cap: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_CAP, capNotice, capProblems } from './creditcards-cap.mjs';

const projects = (approved, other = 3) => [
  ...Array.from({ length: approved }, (_, i) => ({ id: `a${i}`, status: 'approved' })),
  ...Array.from({ length: other }, (_, i) => ({ id: `r${i}`, status: 'rejected' })),
];

test('the cap: quiet below 50, a reminder at 50, a refusal past it', () => {
  assert.equal(PROJECT_CAP, 50);
  assert.equal(capNotice(projects(49)), null);
  assert.deepEqual(capProblems(projects(49)), []);
  assert.match(capNotice(projects(50)), /reached 50 projects.*issues\/101/);
  assert.deepEqual(capProblems(projects(50)), [], '50 is allowed');
  assert.match(capProblems(projects(51))[0], /51 approved projects; .*capped at the first 50/);
  assert.equal(capNotice(projects(10, 60)), null, 'rejected and pending entries never count');
});
