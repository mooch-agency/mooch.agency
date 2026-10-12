// ---------------------------------------------------------------------------
// creditcards-cap.mjs: Credit Cards stops at the first 50 projects.
//
// The index is a showcase of the first 50 community projects we came across,
// not a daily feed. Reaching 50 is the trigger for the freeze in issue #101
// (discovery off, "The first 50" copy, archive links, perks to Monitoring the
// Situation), so the bake and check-site both say so the moment it happens,
// and both refuse a 51st approved project.
// ---------------------------------------------------------------------------

export const PROJECT_CAP = 50;
export const FREEZE_ISSUE = 'https://github.com/mooch-agency/mooch.agency/issues/101';

const approvedCount = (projects) => projects.filter((p) => p.status === 'approved').length;

// True once all 50 are in: discovery stops looking for projects.
export const isFull = (projects) => approvedCount(projects) >= PROJECT_CAP;

const fmt = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

// A 51st approved project, as a readable problem. Empty array means fine.
export function capProblems(projects) {
  const n = approvedCount(projects);
  return n > PROJECT_CAP
    ? [`${n} approved projects; Credit Cards is capped at the first ${PROJECT_CAP}, so reject the newest instead (see ${FREEZE_ISSUE})`]
    : [];
}

// The line under the title, baked into the data-stat="capLine" span: the
// places left while there are any ("2 places left."), then the span the 50
// were collected over ("Collected 24 Sept to 12 Oct 2026.").
export function capLine(projects) {
  const left = Math.max(0, PROJECT_CAP - approvedCount(projects));
  if (left) return `${left} ${left === 1 ? 'place' : 'places'} left.`;
  const days = projects.filter((p) => p.status === 'approved').map((p) => p.added).sort();
  const first = days[0];
  const last = days[days.length - 1];
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  const from = fmt(first, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return `Collected ${from} to ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}.`;
}

// The reminder once the cap is reached, or null before it. Silent once the
// freeze is done and recorded as data.meta.frozenOn.
export function capNotice(projects, frozenOn) {
  return approvedCount(projects) >= PROJECT_CAP && !frozenOn
    ? `Credit Cards has reached ${PROJECT_CAP} projects: time to freeze it, per ${FREEZE_ISSUE}`
    : null;
}
