#!/usr/bin/env node
// ---------------------------------------------------------------------------
// agent-skills.mjs: build (and CI-verify) the Agent Skills discovery index at
// /.well-known/agent-skills/index.json, per the Cloudflare Agent Skills
// Discovery RFC v0.2.0 (github.com/cloudflare/agent-skills-discovery-rfc).
//
// Why this exists: mooch publishes house skills at github.com/mooch-agency/skills.
// The index answers "what skills does mooch.agency publish?" from the front
// door, without an agent having to know the GitHub repo exists.
//
// Why the skills are VENDORED here rather than linked to raw.githubusercontent:
// every index entry carries a SHA-256 `digest` that clients MUST verify. If the
// url pointed at the skills repo, any commit there would silently invalidate
// every digest we serve, and nothing in this repo could detect it. Serving our
// own copies means `--check` is self-contained (no network, no second repo) and
// therefore actually runs in CI. Same ownership split as mooch-cards/: a
// deliberate copy, refreshed on purpose via --sync.
//
// Run:
//   node scripts/agent-skills.mjs                 rebuild index.json + archives
//   node scripts/agent-skills.mjs --check         fail if either has drifted
//   node scripts/agent-skills.mjs --sync <dir>    re-copy from a skills-repo
//                                                 clone, then rebuild
//
// Distribution type follows the RFC: a skill that is SKILL.md alone ships as
// "skill-md"; one with supporting files (scripts/, references/, assets/) ships
// as a "archive" .tar.gz, so its relative references still resolve. The tar is
// written by hand below because it must be byte-for-byte reproducible: any
// nondeterminism (mtimes, uids, file order) would churn the digest on every
// build and make --check meaningless.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, '.well-known', 'agent-skills');
const INDEX_PATH = path.join(SKILLS_DIR, 'index.json');

const SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
const URL_BASE = '/.well-known/agent-skills';

const ARGV = process.argv.slice(2);
const CHECK = ARGV.includes('--check');
const syncAt = ARGV.indexOf('--sync');
const SYNC_FROM = syncAt === -1 ? null : ARGV[syncAt + 1];
if (syncAt !== -1 && !SYNC_FROM) throw new Error('--sync needs a path to a skills-repo clone');

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

// ---------------------------------------------------------------------------
// Reproducible tar.gz
// ---------------------------------------------------------------------------
// A minimal ustar writer. Everything that would otherwise vary between machines
// or runs is pinned: mtime 0, uid/gid 0, fixed mode, files sorted by path. Node's
// gzipSync writes a zero mtime into the gzip header, so the whole artifact is a
// pure function of its contents.
function tarHeader(name, size, mode) {
  const h = Buffer.alloc(512);
  const put = (str, offset, len) => h.write(str.slice(0, len), offset, 'ascii');
  const oct = (num, offset, len) => put(num.toString(8).padStart(len - 1, '0') + '\0', offset, len);

  if (Buffer.byteLength(name) > 100) throw new Error(`path too long for ustar: ${name}`);
  put(name, 0, 100);
  oct(mode, 100, 8);      // mode
  oct(0, 108, 8);         // uid
  oct(0, 116, 8);         // gid
  oct(size, 124, 12);     // size
  oct(0, 136, 12);        // mtime (epoch 0, deliberately)
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 spaces
  put('0', 156, 1);       // typeflag: regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);

  // Checksum is the sum of all header bytes with this field read as 8 spaces,
  // stored as 6 octal digits, NUL, space. It must not spill into the typeflag
  // byte at 156.
  let sum = 0;
  for (const byte of h) sum += byte;
  oct(sum, 148, 7);
  h.write(' ', 155, 1, 'ascii');
  return h;
}

function makeTarGz(files) {
  const parts = [];
  for (const { name, mode, data } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    parts.push(tarHeader(name, data.length, mode), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two empty blocks terminate the archive
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

// ---------------------------------------------------------------------------
// Reading skills off disk
// ---------------------------------------------------------------------------
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push({ name: rel, abs });
  }
  return out;
}

// Pull `name` and `description` out of the SKILL.md YAML frontmatter. The RFC
// says the index description SHOULD match the frontmatter, so we never retype
// it: one source of truth, in the skill itself.
function frontmatter(md, rel) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) throw new Error(`${rel}: no YAML frontmatter`);
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  for (const key of ['name', 'description']) {
    if (!fields[key]) throw new Error(`${rel}: frontmatter is missing "${key}"`);
  }
  return fields;
}

// RFC + Agent Skills spec: 1-64 chars, lowercase alphanumeric and hyphens, no
// leading, trailing or consecutive hyphens.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function build() {
  const dirs = readdirSync(SKILLS_DIR)
    .filter((d) => statSync(path.join(SKILLS_DIR, d)).isDirectory())
    .sort();

  const skills = [];
  const archives = new Map(); // relative artifact path -> bytes

  for (const dir of dirs) {
    const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!existsSync(skillPath)) throw new Error(`${dir}/: no SKILL.md`);

    const files = walk(path.join(SKILLS_DIR, dir));
    const md = readFileSync(skillPath);
    const { name, description } = frontmatter(md.toString('utf8'), `${dir}/SKILL.md`);

    if (name !== dir) throw new Error(`${dir}/SKILL.md: frontmatter name "${name}" does not match its directory`);
    if (!NAME_RE.test(name) || name.length > 64) throw new Error(`"${name}": invalid skill name per the Agent Skills spec`);
    if (description.length > 1024) throw new Error(`"${name}": description exceeds the 1024-char limit`);

    // SKILL.md alone ships as a plain file; anything with supporting resources
    // ships as an archive, so its relative references still resolve.
    if (files.length === 1) {
      skills.push({ name, type: 'skill-md', description, url: `${URL_BASE}/${name}/SKILL.md`, digest: sha256(md) });
    } else {
      const tgz = makeTarGz(files.map((f) => ({
        name: f.name,
        // Scripts stay executable inside the archive; everything else is 0644.
        mode: f.name.startsWith('scripts/') ? 0o755 : 0o644,
        data: readFileSync(f.abs),
      })));
      archives.set(`${name}.tar.gz`, tgz);
      skills.push({ name, type: 'archive', description, url: `${URL_BASE}/${name}.tar.gz`, digest: sha256(tgz) });
    }
  }

  const index = JSON.stringify({ $schema: SCHEMA, skills }, null, 2) + '\n';
  return { index, archives };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (SYNC_FROM) {
  const src = path.resolve(SYNC_FROM.replace(/\/+$/, ''));
  const from = existsSync(path.join(src, 'skills')) ? path.join(src, 'skills') : src;
  if (!existsSync(from)) throw new Error(`--sync: no such directory: ${from}`);
  for (const d of readdirSync(SKILLS_DIR)) {
    if (statSync(path.join(SKILLS_DIR, d)).isDirectory()) rmSync(path.join(SKILLS_DIR, d), { recursive: true });
  }
  cpSync(from, SKILLS_DIR, { recursive: true });
  console.log(`Synced skills from ${from}`);
}

const { index, archives } = build();
const count = JSON.parse(index).skills.length;

if (CHECK) {
  const problems = [];
  const onDisk = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf8') : null;
  if (onDisk !== index) problems.push('.well-known/agent-skills/index.json is stale');
  for (const [rel, bytes] of archives) {
    const abs = path.join(SKILLS_DIR, rel);
    if (!existsSync(abs)) problems.push(`.well-known/agent-skills/${rel} is missing`);
    else if (!readFileSync(abs).equals(bytes)) problems.push(`.well-known/agent-skills/${rel} is stale`);
  }
  if (problems.length) {
    console.error('Agent skills index is out of date:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nRun `pnpm skills:build` and commit the result.');
    process.exit(1);
  }
  console.log(`Agent skills index up to date (${count} skills).`);
} else {
  writeFileSync(INDEX_PATH, index);
  for (const [rel, bytes] of archives) writeFileSync(path.join(SKILLS_DIR, rel), bytes);
  console.log(`Wrote .well-known/agent-skills/index.json (${count} skills, ${archives.size} archive(s)).`);
}
