// ---------------------------------------------------------------------------
// kit-render.mjs: turn a Notion page's blocks into a static workshop kit page.
//
// Why this exists: on 16 and 17 Nov 2026 the Heed Capital kit, served as a
// Notion Sites page, failed to load for several attendees on the room's shared
// Wi-Fi. One Notion page load is about 8 MB across about 790 requests, and ten
// laptops opening it in the same minute stalled. A baked page is tens of KB.
// Notion stays the source: edit the kit there, then re-run `pnpm kit:build`.
//
// This module is pure (blocks in, HTML out) so it can be tested offline.
// scripts/kit-page.mjs does the fetching and writing.
//
// Supported Notion blocks are the ones the kits actually use. Anything else
// throws, so a kit never ships with a silently missing section.
// ---------------------------------------------------------------------------

const SITE = 'https://mooch.agency';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Notion rich text -> inline HTML. Keeps bold, italic, strikethrough,
// underline, inline code, gray text and links; other colours fall back to
// plain text on purpose (the site palette has no Notion equivalents).
export function richText(parts = []) {
  return parts
    .map((p) => {
      let html = escapeHtml(p.plain_text ?? '');
      const a = p.annotations || {};
      if (a.code) html = `<code>${html}</code>`;
      if (a.bold) html = `<strong>${html}</strong>`;
      if (a.italic) html = `<em>${html}</em>`;
      if (a.strikethrough) html = `<s>${html}</s>`;
      if (a.underline) html = `<u>${html}</u>`;
      if (a.color === 'gray') html = `<span class="muted">${html}</span>`;
      const href = p.href || p.text?.link?.url;
      if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
      return html;
    })
    .join('');
}

export function plainText(parts = []) {
  return parts.map((p) => p.plain_text ?? '').join('');
}

// Notion background colours -> a site tint. Only the two the kits use are
// mapped; anything else renders as the neutral surface.
const CALLOUT_TINT = { yellow_background: 'warm', gray_background: 'neutral' };

// Render a list of sibling blocks. Consecutive list items are grouped into
// one <ul>/<ol>. ctx carries the heading offset and the code-block counter.
export function renderBlocks(blocks, ctx) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') {
      const tag = b.type === 'bulleted_list_item' ? 'ul' : 'ol';
      const items = [];
      while (i < blocks.length && blocks[i].type === b.type) {
        items.push(blocks[i]);
        i++;
      }
      i--;
      out.push(`<${tag}>${items.map((it) => `<li>${richText(it[it.type].rich_text)}${renderBlocks(it.children || [], ctx)}</li>`).join('')}</${tag}>`);
      continue;
    }
    out.push(renderBlock(b, ctx, blocks[i - 1]));
  }
  return out.join('\n');
}

function renderBlock(b, ctx, prev) {
  const v = b[b.type] || {};
  switch (b.type) {
    case 'paragraph': {
      const html = richText(v.rich_text);
      return html ? `<p>${html}</p>` : '';
    }
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      // Map the page's shallowest Notion heading to <h2> (the title is <h1>),
      // so levels never skip, whatever depth the kit's author started at.
      const level = Number(b.type.slice(-1)) - ctx.minHeading + 2;
      return `<h${level}>${richText(v.rich_text)}</h${level}>`;
    }
    case 'toggle':
      return `<details class="kit-toggle"><summary>${richText(v.rich_text)}</summary><div class="kit-toggle-body">\n${renderBlocks(b.children || [], ctx)}\n</div></details>`;
    case 'callout': {
      const tint = CALLOUT_TINT[v.color] || 'neutral';
      const icon = v.icon?.type === 'emoji' ? `<span class="kit-callout-icon" aria-hidden="true">${escapeHtml(v.icon.emoji)}</span>` : '';
      const kids = renderBlocks(b.children || [], ctx);
      // A <div role="note">, not <aside>: two asides would be two unnamed
      // landmarks, which html-validate (rightly) rejects.
      return `<div class="kit-callout kit-callout--${tint}" role="note">${icon}<div><p>${richText(v.rich_text)}</p>${kids}</div></div>`;
    }
    case 'code': {
      // Every code block is a prompt to paste into Claude, so each gets a
      // Copy button (state.js wires it up and fires the kit_copy event).
      ctx.codeCount += 1;
      const id = `prompt-${ctx.codeCount}`;
      const label = prev?.type === 'paragraph' ? plainText(prev.paragraph.rich_text).replace(/:$/, '') : 'prompt';
      return `<div class="kit-code"><button class="copy-btn" type="button" data-copy-target="${id}" data-copy-event="kit_copy" data-copy-event-title aria-label="Copy ${escapeHtml(label)}">Copy</button><pre id="${id}"><code>${escapeHtml(plainText(v.rich_text))}</code></pre></div>`;
    }
    case 'table': {
      const rows = (b.children || []).map((r) => r.table_row.cells);
      const head = v.has_column_header ? rows.shift() : null;
      const thead = head ? `<thead><tr>${head.map((c) => `<th scope="col">${richText(c)}</th>`).join('')}</tr></thead>` : '';
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${richText(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      return `<div class="kit-table"><table>${thead}${tbody}</table></div>`;
    }
    case 'divider':
      return '<hr>';
    default:
      throw new Error(`kit-render: unsupported Notion block "${b.type}" (id ${b.id}). Add it to renderBlock or remove it from the kit.`);
  }
}

// Shallowest heading level used anywhere in the tree (1 to 3), or 3 if none.
function minHeading(blocks) {
  let min = 3;
  const walk = (list) => list.forEach((b) => {
    if (/^heading_[123]$/.test(b.type)) min = Math.min(min, Number(b.type.slice(-1)));
    if (b.children) walk(b.children);
  });
  walk(blocks);
  return min;
}

// "16 Nov 2026" from an ISO timestamp, in UTC so the bake is deterministic.
export function shortDate(iso) {
  const d = new Date(iso);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}

// The whole page. kit: { slug, description, notion }, page: { title,
// lastEdited }, blocks: the page's top-level blocks with nested children.
// ogImage is the brand card URL, already stamped (see kit-page.mjs).
export function renderKitPage({ kit, page, blocks, ogImage }) {
  const ctx = { codeCount: 0, minHeading: minHeading(blocks) };
  const body = renderBlocks(blocks, ctx);
  const url = `${SITE}/kit/${kit.slug}`;
  const title = `${page.title} | Mooch Agency`;
  const desc = kit.description;
  const year = new Date(page.lastEdited).getUTCFullYear();

  return `<!DOCTYPE html>
<!-- Generated by scripts/kit-page.mjs from Notion page ${kit.notion}.
     Do not edit by hand: edit the kit in Notion, then run pnpm kit:build. -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180.png">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${escapeHtml(page.title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Mooch Agency">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/ui.css">
<style>
  /* Page-local layout only. Colours, type and spacing come from tokens.css.
     No web fonts: the point of this page is to load fast on a crowded line. */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  body { font-family: var(--sans); font-size: 17px; line-height: 1.55; color: var(--ink); background: var(--paper); }
  a { color: inherit; text-decoration: underline; text-decoration-color: var(--hairline-focus); text-underline-offset: 2px; }
  a:hover { text-decoration-color: var(--ink); }
  .muted { color: var(--muted); }
  code { font-family: var(--mono); font-size: 0.88em; }

  .topbar { display: flex; justify-content: space-between; gap: 16px; padding: 20px var(--pad-x); font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted-small); border-bottom: 1px solid var(--hairline); }
  .topbar a { color: var(--ink); text-decoration: none; }

  main { max-width: var(--col); margin: 0 auto; padding: clamp(40px, 8vw, 88px) var(--pad-x) clamp(64px, 10vw, 120px); }
  h1 { font-size: clamp(30px, 5vw, 44px); line-height: 1.1; letter-spacing: -0.02em; font-weight: 600; color: var(--black); margin-bottom: 10px; }
  .updated { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted-small); margin-bottom: 32px; }
  h2 { font-size: 21px; font-weight: 600; color: var(--black); margin: 48px 0 16px; }
  h3, h4 { font-size: 17px; font-weight: 600; color: var(--black); margin: 32px 0 12px; }
  main p { margin-bottom: 14px; }
  main ul, main ol { margin: 0 0 16px 1.3em; }
  main li { margin-bottom: 6px; }
  hr { border: 0; border-top: 1px solid var(--hairline); margin: 40px 0; }

  .kit-toggle { border-top: 1px solid var(--hairline); }
  .kit-toggle:last-of-type { border-bottom: 1px solid var(--hairline); }
  .kit-toggle > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 12px; padding: 16px 0; min-height: 44px; font-size: 18px; }
  .kit-toggle > summary::-webkit-details-marker { display: none; }
  .kit-toggle > summary::before { content: "+"; font-family: var(--mono); color: var(--muted); width: 1ch; transition: transform var(--t-deliver) var(--ease-deliver); }
  .kit-toggle[open] > summary::before { transform: rotate(45deg); }
  .kit-toggle > summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .kit-toggle-body { padding: 0 0 24px; }

  .kit-callout { display: flex; gap: 12px; padding: 16px 18px; border-radius: 10px; margin: 0 0 24px; background: var(--surface); box-shadow: var(--shadow-border); }
  .kit-callout--warm { background: var(--cat-plaything); }
  .kit-callout p:last-child { margin-bottom: 0; }
  .kit-callout-icon { line-height: 1.55; }

  .kit-code { position: relative; margin: 0 0 20px; }
  .kit-code pre { background: var(--surface); box-shadow: var(--shadow-border); border-radius: 10px; padding: 64px 18px 18px; font-family: var(--mono); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .kit-code pre code { font-size: inherit; }
  .kit-code .copy-btn { position: absolute; top: 10px; right: 10px; }

  .kit-table { overflow-x: auto; margin: 0 0 20px; }
  .kit-table table { border-collapse: collapse; width: 100%; font-size: 15px; }
  .kit-table th, .kit-table td { text-align: left; vertical-align: top; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--hairline); }
  .kit-table th { font-weight: 600; color: var(--muted-small); font-size: 13px; }

  .colophon { padding: 28px var(--pad-x); border-top: 1px solid var(--hairline); font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted-small); text-align: center; }

  @media print {
    .topbar, .copy-btn, .colophon { display: none; }
    .kit-code pre { padding-top: 18px; box-shadow: none; border: 1px solid var(--hairline); }
  }
</style>
</head>
<body>

<header class="topbar">
  <span><a href="/">Mooch</a> &nbsp;/&nbsp; Recipe kit</span>
</header>

<main>
<h1>${escapeHtml(page.title)}</h1>
<p class="updated">Updated ${shortDate(page.lastEdited)}</p>
${body}
</main>

<footer class="colophon">
  <span>&copy; ${year} Mooch Agency Ltd.</span>
</footer>

<!-- Vercel Web Analytics -->
<script>
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/analytics.js"></script>
<!-- Copy buttons: shared behaviour from /state.js, configured by the
     data-copy-* attributes. kit_copy fires only after a successful copy. -->
<script src="/state.js"></script>
</body>
</html>
`;
}
