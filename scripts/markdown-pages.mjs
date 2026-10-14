#!/usr/bin/env node
// ---------------------------------------------------------------------------
// markdown-pages.mjs: a Markdown copy of every shipped page, for agents.
//
// Why: Cloudflare's agent-readiness scan (the one AXBeat publishes) checks
// "Markdown for Agents": ask for a page with `Accept: text/markdown` and you
// should get its words without the layout. Until this existed mooch.agency
// sat at 2/5 on that one missing check, while publishing a board and an essay
// that tell everyone else to do it.
//
// How it fits together:
//   1. This script reads each shipped page (site-files.mjs), takes its <main>,
//      and writes md/<slug>.md (md/index.md for the homepage), plus
//      md/slugs.js listing the slugs that have a Markdown copy.
//   2. middleware.js serves md/<slug>.md in place of the HTML when a request
//      asks for text/markdown, and only for slugs in md/slugs.js.
//   3. The files are committed (the site has no build step), and
//      `--check` fails CI when a page changed but its Markdown wasn't rebuilt.
//
// Run:   pnpm md:build    (rewrite md/)
//        pnpm md:check    (exit 1 if md/ is stale)
//
// The converter is deliberately small: it handles the elements these pages
// actually use (headings, paragraphs, lists, links, emphasis, tables, quotes,
// code, images with alt text). Interactive furniture (buttons, forms, inputs,
// svg, aria-hidden decoration) is dropped, since an agent can't use it.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { shippedPages } from './site-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'md');
const SITE = 'https://mooch.agency';
const CHECK = process.argv.includes('--check');

// index.html -> '' (served at /), prompts/deslop.html -> 'prompts/deslop'
const slugOf = (rel) => (rel === 'index.html' ? '' : rel.replace(/\.html$/, ''));
const fileOf = (slug) => (slug === '' ? 'index.md' : `${slug}.md`);

// Absolute URLs, so a Markdown copy read out of context still links somewhere
// real. Same-page anchors stay as written.
function absUrl(href) {
  if (!href || href.startsWith('#') || /^(mailto|tel):/.test(href)) return href || '';
  try {
    const u = new URL(href, SITE + '/');
    // Our own pages are served without .html (cleanUrls); link the real address.
    if (u.origin === SITE) u.pathname = u.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    return u.href.replace(/\/$/, u.pathname === '/' && !u.search && !u.hash ? '' : '/').replace(/\/$/, '');
  } catch { return href; }
}

const clean = (s) => s.replace(/\s+/g, ' ');

// Inline content: text plus links/emphasis/code, collapsed to one line.
function inline($, node) {
  let out = '';
  let prevTag = false;
  $(node).contents().each((_, el) => {
    if (el.type === 'text') {
      const t = clean(el.data);
      if (prevTag && /\w$/.test(out) && /^\w/.test(t)) out += ' ';
      out += t; prevTag = false; return;
    }
    if (el.type !== 'tag') return;
    const tag = el.tagName.toLowerCase();
    // Two elements side by side that CSS separates visually (the board's
    // <span class="brand">BOB</span><span class="brandurl">gobob.xyz</span>)
    // would otherwise run together as "BOBgobob.xyz".
    if (prevTag && /\w$/.test(out) && /^\w/.test($(el).text().trim())) out += ' ';
    prevTag = true;
    const inner = () => inline($, el).trim();
    switch (tag) {
      case 'a': {
        const text = inner();
        const href = absUrl($(el).attr('href'));
        out += text ? (href ? `[${text}](${href})` : text) : '';
        break;
      }
      case 'strong': case 'b': { const t = inner(); out += t ? `**${t}**` : ''; break; }
      case 'em': case 'i': { const t = inner(); out += t ? `*${t}*` : ''; break; }
      case 'code': out += '`' + $(el).text() + '`'; break;
      case 'br': out += '  \n'; break;
      case 'img': { const alt = $(el).attr('alt'); if (alt) out += `![${alt}](${absUrl($(el).attr('src'))})`; break; }
      default: out += inline($, el);
    }
  });
  return out;
}

const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'pre', 'figure', 'section', 'article', 'div', 'details', 'summary', 'dl', 'hr', 'header', 'aside', 'figcaption']);

function table($, el) {
  const rows = $(el).find('tr').toArray().map((tr) =>
    $(tr).children('th,td').toArray().map((c) => inline($, c).trim().replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const caption = $(el).find('caption').first().text().trim();
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)];
  return (caption ? clean(caption) + '\n\n' : '') + lines.join('\n');
}

function list($, el, depth) {
  const ordered = el.tagName.toLowerCase() === 'ol';
  return $(el).children('li').toArray().map((li, i) => {
    const nested = $(li).children('ul,ol').toArray();
    const $li = $(li).clone(); $li.children('ul,ol').remove();
    const head = `${'  '.repeat(depth)}${ordered ? `${i + 1}.` : '-'} ${inline($, $li).trim()}`;
    return [head, ...nested.map((n) => list($, n, depth + 1))].join('\n');
  }).join('\n');
}

// Block content: returns an array of Markdown blocks.
function blocks($, node) {
  const out = [];
  let para = '';
  const flush = () => { const t = para.trim(); if (t) out.push(t); para = ''; };
  $(node).contents().each((_, el) => {
    const add = (t) => { if (/\w$/.test(para) && /^\w/.test(t)) para += ' '; para += t; };
    if (el.type === 'text') { add(clean(el.data)); return; }
    if (el.type !== 'tag') return;
    const tag = el.tagName.toLowerCase();
    // A link wrapping a whole card (homepage work list): one list line each,
    // rather than seven cards run together as one paragraph.
    if (tag === 'a' && ($(el).find('div,p,h1,h2,h3,h4,h5,h6').length || $(el).children().length >= 2)) {
      flush();
      const t = inline($, el).replace(/ {2,}/g, ' ').trim();
      if (t) out.push(`- [${t}](${absUrl($(el).attr('href'))})`);
      return;
    }
    // Inline element sitting directly in a block container: render it inline
    // via a throwaway wrapper, so its own tag (link, emphasis) is kept.
    if (!BLOCK.has(tag)) { add(inline($, $('<span></span>').append($(el).clone()))); return; }
    flush();
    if (/^h[1-6]$/.test(tag)) { const t = inline($, el).trim(); if (t) out.push(`${'#'.repeat(+tag[1])} ${t}`); }
    else if (tag === 'p' || tag === 'summary' || tag === 'figcaption') { const t = inline($, el).trim(); if (t) out.push(t); }
    else if (tag === 'ul' || tag === 'ol') { const t = list($, el, 0); if (t.trim()) out.push(t); }
    else if (tag === 'table') { const t = table($, el); if (t) out.push(t); }
    else if (tag === 'blockquote') { const t = blocks($, el).join('\n\n'); if (t) out.push(t.split('\n').map((l) => `> ${l}`).join('\n')); }
    else if (tag === 'pre') { out.push('```\n' + $(el).text().replace(/\n+$/, '') + '\n```'); }
    else if (tag === 'hr') { out.push('---'); }
    else out.push(...blocks($, el));
  });
  flush();
  return out;
}

export function pageToMarkdown(html, slug) {
  const $ = load(html);
  const title = clean($('title').first().text()).trim();
  const description = clean($('meta[name="description"]').attr('content') || '').trim();
  const main = $('main').first().length ? $('main').first() : $('body');
  // Furniture an agent can't use, and decoration hidden from assistive tech.
  main.find('script,style,noscript,template,svg,button,form,input,select,textarea,label,dialog,[aria-hidden="true"],[hidden]').remove();
  const body = blocks($, main).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const url = slug === '' ? SITE : `${SITE}/${slug}`;
  const head = [`<!-- Markdown copy of ${url} for agents. Generated by scripts/markdown-pages.mjs; edit the HTML page, not this file. -->`];
  // The page's own h1 is the heading; <title> only stands in when there is none.
  if (!/^# /m.test(body)) head.push(`# ${title}`);
  if (description) head.push(`> ${description}`);
  return `${head.join('\n\n')}\n\n${body}\n\nSource: ${url}  \nContact: hey@mooch.agency\n`;
}

function build() {
  const files = new Map();
  const slugs = [];
  for (const rel of shippedPages(ROOT)) {
    const slug = slugOf(rel);
    files.set(fileOf(slug), pageToMarkdown(readFileSync(path.join(ROOT, rel), 'utf8'), slug));
    slugs.push(slug);
  }
  // An ES module rather than JSON, so middleware.js can import it with no
  // JSON-import support needed from the bundler.
  files.set('slugs.js', `// Generated by scripts/markdown-pages.mjs. Pages with a Markdown copy in md/; middleware.js reads this.\nexport default ${JSON.stringify(slugs, null, 2)};\n`);
  return files;
}

// Rewrite md/ from the current pages. Exported so the two automated bakes
// (axbeat-data.mjs weekly, creditcards-update.mjs daily) refresh the copy of
// the page they just changed in the same run, and CI's --check stays green.
export function writeMarkdown() {
  const files = build();
  rmSync(OUT, { recursive: true, force: true });
  for (const [f, body] of files) {
    const p = path.join(OUT, f);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return files.size - 1;
}

export function staleMarkdown() {
  return [...build()].filter(([f, body]) => {
    const p = path.join(OUT, f);
    return !existsSync(p) || readFileSync(p, 'utf8') !== body;
  }).map(([f]) => f);
}

// CLI only when run directly, not when imported by a bake script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (CHECK) {
    const stale = staleMarkdown();
    if (stale.length) { console.error(`markdown-pages --check: stale or missing in md/: ${stale.join(', ')}\nRun: pnpm md:build`); process.exit(1); }
    console.log('markdown-pages --check: md/ matches every shipped page. PASS');
  } else {
    console.log(`markdown-pages: wrote ${writeMarkdown()} pages + slugs.js to md/`);
  }
}
