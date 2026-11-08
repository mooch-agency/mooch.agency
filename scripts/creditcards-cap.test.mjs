// Offline checks for the 50-project cap: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROJECT_CAP,
  capLine,
  capNotice,
  capProblems,
  freezeProblems,
  isFrozen,
  isFull,
  statusProblems,
} from './creditcards-cap.mjs';
import { discover } from './creditcards-update.mjs';

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
  assert.equal(capLine(projects(50)), '');
  assert.equal(isFull(projects(49)), false);
  assert.equal(isFull(projects(50)), true);
  assert.equal(capLine(projects(49), '2026-10-12'), '', 'frozen: no places left, whatever the count');
});

test('a typo status is a readable problem, not a silent drop', () => {
  assert.deepEqual(statusProblems(projects(3)), []);
  assert.deepEqual(statusProblems([{ id: 'p0', status: 'pending' }]), []);
  const msgs = statusProblems([{ id: 'oops', status: 'aproved' }]);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /"oops" has status "aproved"; it must be one of pending, approved, rejected/);
});

test('frozenOn is the freeze switch', () => {
  assert.equal(isFrozen({ meta: { frozenOn: '2026-10-12' } }), true);
  assert.equal(isFrozen({ meta: {} }), false);
  assert.equal(isFrozen(undefined), false);
});

test('approvals after the freeze fail, except the grandfathered one', () => {
  const meta = { frozenOn: '2026-10-12' };
  assert.deepEqual(freezeProblems({ meta, projects: projects(49) }), [], 'on-time approvals pass');
  assert.deepEqual(freezeProblems({ meta: {}, projects: projects(49) }), [], 'quiet before the freeze');
  // Grid Phantoms was approved eight days after the freeze, before this
  // check existed: let through by id, and only that id.
  const grandfathered = { id: 'gridphantoms-app-credits', status: 'approved', added: '2026-10-20' };
  assert.deepEqual(freezeProblems({ meta, projects: [grandfathered] }), []);
  const msgs = freezeProblems({ meta, projects: [{ id: 'latecomer', status: 'approved', added: '2026-11-01' }] });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /"latecomer" was approved 2026-11-01, after the 2026-10-12 freeze.*issues\/101/);
  assert.deepEqual(
    freezeProblems({ meta, projects: [{ id: 'late-pending', status: 'pending', added: '2026-11-01' }] }),
    [],
    'pending entries after the freeze are not approvals'
  );
});

test('frozen data keeps discovery off, even below 50 approved', async () => {
  const data = { projects: projects(49), meta: { frozenOn: '2026-10-12' } };
  const lines = [];
  const neverFetch = () => {
    throw new Error('discovery touched the network while frozen');
  };
  const read = await discover(data, 'token-present', neverFetch, (l) => lines.push(l));
  assert.equal(read, 0);
  assert.match(lines.join('\n'), /froze on 2026-10-12: discovery off for good/);
});
