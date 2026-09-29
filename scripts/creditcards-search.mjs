// ---------------------------------------------------------------------------
// creditcards-search.mjs: the discovery search tiers, built from
// data/creditcards-search.json, whose terms come from docs/credits-glossary.md.
//
// Pure functions only (no network): buildQuery() turns a tier into an X recent
// search query, tiersFor() picks the tiers a given run should read, and
// wantsBioFallback() decides when a linkless post may borrow its author's
// profile link. Not wired into creditcards-update.mjs yet.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEARCH_CONFIG_FILE = 'data/creditcards-search.json';
// X recent search accepts 512 characters on the self-serve tiers.
export const MAX_QUERY_LENGTH = 512;

export function loadSearchConfig(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, SEARCH_CONFIG_FILE), 'utf8'));
}

const group = (terms) => (terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`);

export function buildQuery(tier, config) {
  const parts = [];
  if (tier.any && tier.any.length) parts.push(group(tier.any));
  for (const g of tier.all || []) if (g.length) parts.push(group(g));
  parts.push(...(tier.operators || []));
  const exclude = [...(tier.exclude || []), ...(tier.useNoise ? config.noise.exclude : [])];
  for (const t of [...new Set(exclude)]) parts.push(`-${t}`);
  return parts.join(' ');
}

// "morning" tiers run once a UTC day: on the first run whose date differs
// from the tier's last run.
export function tiersFor(config, { lastRuns = {}, now = new Date(), experimental = false } = {}) {
  const today = now.toISOString().slice(0, 10);
  const all = [...config.tiers, ...(experimental ? config.experimental || [] : [])];
  return all.filter((t) => t.schedule === 'every' || (lastRuns[t.id] || '').slice(0, 10) !== today);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (terms) => new RegExp(`(^|[^a-z0-9])(${terms.map(escape).join('|')})(?![a-z0-9])`, 'i');

export function wantsBioFallback(text, config) {
  const { announce, strong } = config.bioFallback;
  const t = String(text || '').replace(/[’]/g, "'");
  return phraseRe(announce).test(t) && phraseRe(strong).test(t);
}

// Every word or phrase a config names, for the glossary check. Operators
// (url:, to:, from:, is:, has:) and OR are structure, not vocabulary.
export function configTerms(config) {
  const out = new Set();
  const add = (s) => {
    const text = String(s).replace(/\b(?:url|to|from|is|has):("[^"]*"|\S+)/g, ' ');
    for (const m of text.matchAll(/"([^"]+)"|([@$]?[A-Za-z0-9][A-Za-z0-9.,']*)/g)) {
      const term = (m[1] || m[2]).replace(/[.,]$/, '');
      if (term !== 'OR') out.add(term.toLowerCase());
    }
  };
  for (const t of [...config.tiers, ...(config.experimental || [])]) {
    for (const s of [...(t.any || []), ...(t.all || []).flat(), ...(t.exclude || [])]) add(s);
  }
  for (const s of config.noise.exclude) add(s);
  return [...out];
}
