#!/usr/bin/env node
// ---------------------------------------------------------------------------
// kit-page.mjs: bake a workshop recipe kit from Notion into kit/<slug>.html.
//
//   NOTION_TOKEN=ntn_... pnpm kit:build          # every kit in data/kits.json
//   NOTION_TOKEN=ntn_... pnpm kit:build heed     # one kit
//
// Notion is the source of truth for the words; this script only copies them
// into a static page that loads on a crowded venue Wi-Fi (see kit-render.mjs
// for why). Edit the kit in Notion, re-run, commit the HTML.
//
// NOTION_TOKEN is the "moochbot" internal integration token (Keystore,
// Notion section), and the kit page must be shared with that integration.
// Never commit the token. Network-dependent, so deliberately not in ci:check.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderKitPage } from './kit-render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

async function notion(token, urlPath) {
  const res = await fetch(`${API}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion ${res.status} on ${urlPath}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// All children of a block, following pagination, with nested children
// attached as .children (toggles, callouts, tables, list items).
async function children(token, id) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `&start_cursor=${cursor}` : '';
    const page = await notion(token, `/blocks/${id}/children?page_size=100${q}`);
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  for (const b of out) {
    if (b.has_children) b.children = await children(token, b.id);
  }
  return out;
}

// The brand card URL, with whatever stamp the site currently serves it under,
// read from the og-image redirect in vercel.json so it never goes stale here.
function brandCard() {
  const vercel = readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  const m = vercel.match(/\/og-image\.png\?v=[0-9a-f]+/);
  return `https://mooch.agency${m ? m[0] : '/og-image.png'}`;
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error('✗ NOTION_TOKEN is not set. Use the "moochbot" integration token from the Keystore.');
    process.exit(1);
  }
  const only = process.argv[2];
  const kits = JSON.parse(readFileSync(path.join(ROOT, 'data/kits.json'), 'utf8'))
    .filter((k) => !only || k.slug === only);
  if (!kits.length) {
    console.error(`✗ No kit "${only}" in data/kits.json.`);
    process.exit(1);
  }

  mkdirSync(path.join(ROOT, 'kit'), { recursive: true });
  for (const kit of kits) {
    const meta = await notion(token, `/pages/${kit.notion}`);
    const titleProp = Object.values(meta.properties).find((p) => p.type === 'title');
    const page = {
      title: titleProp.title.map((t) => t.plain_text).join(''),
      lastEdited: meta.last_edited_time,
    };
    const blocks = await children(token, kit.notion);
    const html = renderKitPage({ kit, page, blocks, ogImage: brandCard() });
    const out = path.join(ROOT, 'kit', `${kit.slug}.html`);
    writeFileSync(out, html);
    console.log(`✓ kit/${kit.slug}.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB  (${page.title}, edited ${page.lastEdited})`);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
