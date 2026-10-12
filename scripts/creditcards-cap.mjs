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

// A 51st approved project, as a readable problem. Empty array means fine.
export function capProblems(projects) {
  const n = approvedCount(projects);
  return n > PROJECT_CAP
    ? [`${n} approved projects; Credit Cards is capped at the first ${PROJECT_CAP}, so reject the newest instead (see ${FREEZE_ISSUE})`]
    : [];
}

// The line under the title while places remain ("2 places left."), baked
// into the data-stat="capLine" span. Empty once all 50 are in.
export function capLine(projects) {
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
