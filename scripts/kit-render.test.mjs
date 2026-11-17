// Offline checks for the kit renderer: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlocks, renderKitPage, richText } from './kit-render.mjs';

const rt = (text, annotations = {}, href = null) => ({ plain_text: text, annotations, href });
const ctx = () => ({ codeCount: 0, minHeading: 3 });

test('rich text keeps bold, gray and links, and escapes HTML', () => {
  assert.equal(richText([rt('a<b', { bold: true })]), '<strong>a&lt;b</strong>');
  assert.equal(richText([rt('note', { color: 'gray' })]), '<span class="muted">note</span>');
  assert.equal(richText([rt('us', {}, 'mailto:hey@mooch.agency')]), '<a href="mailto:hey@mooch.agency">us</a>');
});

test('consecutive list items share one list', () => {
  const li = (t) => ({ type: 'numbered_list_item', numbered_list_item: { rich_text: [rt(t)] } });
  assert.equal(renderBlocks([li('one'), li('two')], ctx()), '<ol><li>one</li><li>two</li></ol>');
});

test('each code block gets its own Copy button, labelled by the line above it', () => {
  const html = renderBlocks([
    { type: 'paragraph', paragraph: { rich_text: [rt('The job:', { bold: true })] } },
    { type: 'code', code: { rich_text: [rt('WHAT\nDo it & <stop>')] } },
    { type: 'code', code: { rich_text: [rt('second')] } },
  ], ctx());
  assert.match(html, /data-copy-target="prompt-1"[^>]*aria-label="Copy The job"/);
  assert.match(html, /<pre id="prompt-1"><code>WHAT\nDo it &amp; &lt;stop&gt;<\/code><\/pre>/);
  assert.match(html, /data-copy-target="prompt-2"/);
  assert.match(html, /data-copy-event="kit_copy"/);
});

test('an unsupported block fails the bake instead of vanishing', () => {
  assert.throws(() => renderBlocks([{ type: 'image', id: 'x', image: {} }], ctx()), /unsupported Notion block "image"/);
});

test('the shallowest heading becomes h2 under the page h1', () => {
  const html = renderKitPage({
    kit: { slug: 't', notion: 'n', description: 'd' },
    page: { title: 'Kit', lastEdited: '2026-11-16T19:32:00.000Z' },
    blocks: [{ type: 'heading_3', heading_3: { rich_text: [rt('After')] } }],
    ogImage: 'https://mooch.agency/og-image.png',
  });
  assert.match(html, /<h2>After<\/h2>/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /Updated 16 Nov 2026/);
});
