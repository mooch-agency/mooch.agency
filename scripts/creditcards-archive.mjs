// ---------------------------------------------------------------------------
// creditcards-archive.mjs: a Wayback Machine copy of every project.
//
// Once the index is full (creditcards-cap.mjs) it is a showcase that should
// outlive the projects in it. Each approved project gets an `archive` link:
// the newest existing snapshot taken on or after the day it was listed, or a
// fresh Save Page Now capture when there is none. Runs inside the daily job
// (this container's egress is refused by archive.org), a few projects a run so
// the anonymous save limit is never hit, and never fails the run: a project
// that cannot be archived today is tried again tomorrow.
//
// A project whose site has gone gets `"offline": true` by hand. Its card then
// opens the archived copy instead, and says so.
// ---------------------------------------------------------------------------

export const ARCHIVE_PER_RUN = 5;
const AVAILABLE = 'https://archive.org/wayback/available?url=';
const SAVE = 'https://web.archive.org/save/';
const SNAPSHOT_RE = /^https:\/\/web\.archive\.org\/web\/\d{14}\//;

const ymd = (iso) => iso.replaceAll('-', '');

async function snapshotFor(p, fetchImpl) {
  const res = await fetchImpl(AVAILABLE + encodeURIComponent(p.url), { signal: AbortSignal.timeout(20_000) });
  if (res.ok) {
    const s = (await res.json())?.archived_snapshots?.closest;
    if (s && s.available && String(s.status) === '200' && String(s.timestamp).slice(0, 8) >= ymd(p.added)) {
      return s.url.replace(/^http:/, 'https:');
    }
  }
  const save = await fetchImpl(SAVE + p.url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  const loc = (save.headers && (save.headers.get('content-location') || save.headers.get('location'))) || '';
  const m = loc.match(/\/web\/(\d{14})\//);
  return m ? `https://web.archive.org/web/${m[1]}/${p.url}` : null;
}

export async function archiveProjects(projects, fetchImpl = fetch, log = console.log, logErr = console.error) {
  const missing = projects.filter((p) => p.status === 'approved' && !p.archive);
  let archived = 0;
  for (const p of missing.slice(0, ARCHIVE_PER_RUN)) {
    try {
      const url = await snapshotFor(p, fetchImpl);
      if (url) {
        p.archive = url;
        archived++;
        log(`  + archived ${p.name}: ${url}`);
      } else {
        logErr(`  - no snapshot for ${p.name} yet, retrying next run`);
      }
    } catch (e) {
      logErr(`  - archiving ${p.name} failed, retrying next run: ${e.message}`);
    }
  }
  return { archived, left: missing.length - archived };
}

// Readable problems with the archive fields. Empty array means fine.
export function archiveProblems(projects) {
  const out = [];
  for (const p of projects) {
    if (p.archive !== undefined && !SNAPSHOT_RE.test(p.archive)) out.push(`"${p.name}" (${p.id}) has archive "${p.archive}"; it must be a web.archive.org/web/<timestamp>/ link`);
    if (p.offline && !p.archive) out.push(`"${p.name}" (${p.id}) is marked offline but has no archive link to send visitors to`);
  }
  return out;
}
