// ---------------------------------------------------------------------------
// creditcards-cap.mjs: Credit Cards stops at the first 50 projects.
//
// The index is a showcase of the first 50 community projects we came across,
// not a daily feed. Reaching 50 is the trigger for the freeze in issue #101
// (discovery off, "The first 50" copy, archive links, perks to Monitoring the
// Situation), so the bake and check-site both say so the moment it happens,
// and both refuse a 51st approved project.
//
// data.meta.frozenOn is the freeze switch, not the approved count. The count
// gated discovery on its own until Nov 2026, which meant rejecting one
// project (50 down to 49) would have quietly resumed the paid X searches
// from weeks-old cursors. isFrozen() is what everything reads now.
// ---------------------------------------------------------------------------

export const PROJECT_CAP = 50;
export const FREEZE_ISSUE = 'https://github.com/mooch-agency/mooch.agency/issues/101';

// Every status a project may carry. Discovery writes "pending", a human flips
// to "approved" or "rejected"; anything else is a typo that the bake would
// silently drop, so statusProblems() refuses it.
export const STATUSES = ['pending', 'approved', 'rejected'];

const approvedCount = (projects) => projects.filter((p) => p.status === 'approved').length;

// True once all 50 are in: discovery stops looking for projects.
export const isFull = (projects) => approvedCount(projects) >= PROJECT_CAP;

// The freeze switch: recorded once in data.meta.frozenOn when the index
// filled (12 Oct 2026) and permanent from then on, whatever the count does.
export const isFrozen = (data) => Boolean(data && data.meta && data.meta.frozenOn);

// A 51st approved project, as a readable problem. Empty array means fine.
export function capProblems(projects) {
  const n = approvedCount(projects);
  return n > PROJECT_CAP
    ? [`${n} approved projects; Credit Cards is capped at the first ${PROJECT_CAP}, so reject the newest instead (see ${FREEZE_ISSUE})`]
    : [];
}

// A status outside the enum, as a readable problem per project. A typo here
// used to pass every check while the bake dropped the project silently.
export function statusProblems(projects) {
  return projects
    .filter((p) => !STATUSES.includes(p.status))
    .map((p) => `"${p.id || p.name}" has status "${p.status}"; it must be one of ${STATUSES.join(', ')}`);
}

// Approved after the freeze. Grid Phantoms launched the day it asked in and
// was approved eight days after frozenOn, before this check existed, so it is
// let through by id; anything newer is a problem.
const LATE_APPROVALS = new Set(['gridphantoms-app-credits']);

export function freezeProblems(data) {
  if (!isFrozen(data)) return [];
  const frozenOn = data.meta.frozenOn;
  return (data.projects || [])
    .filter((p) => p.status === 'approved' && p.added > frozenOn && !LATE_APPROVALS.has(p.id))
    .map((p) => `"${p.id || p.name}" was approved ${p.added}, after the ${frozenOn} freeze; the index is frozen, so reject it (see ${FREEZE_ISSUE})`);
}

// The line under the title while places remain ("2 places left."), baked
// into the data-stat="capLine" span. Empty once all 50 are in, and empty for
// good once frozen, so a rejection cannot resurrect it.
export function capLine(projects, frozenOn) {
  if (frozenOn) return '';
  const left = Math.max(0, PROJECT_CAP - approvedCount(projects));
  return left ? `${left} ${left === 1 ? 'place' : 'places'} left.` : '';
}

// The reminder once the cap is reached, or null before it. Silent once the
// freeze is done and recorded as data.meta.frozenOn.
export function capNotice(projects, frozenOn) {
  return approvedCount(projects) >= PROJECT_CAP && !frozenOn
    ? `Credit Cards has reached ${PROJECT_CAP} projects: time to freeze it, per ${FREEZE_ISSUE}`
    : null;
}
