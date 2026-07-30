// Item 4: the judge sees destinations, not just prose.
//   node --test scripts/bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, linksBlock } from './bundle.mjs';

const page = (over = {}) => ({
  url: 'https://example.com/',
  title: 'Home',
  text: 'Take the quiz today.',
  links: [{ href: 'https://www.quiz.example.com//default', label: 'Take the quiz' }],
  ...over,
});

test('the judge sees where a link points, not just its text', () => {
  const out = buildBundle([page()]);
  assert.match(out, /Take the quiz -> https:\/\/www\.quiz\.example\.com\/\/default/);
  assert.match(out, /LINKS ON THIS PAGE/);
});

// The apexvolumetrics case end to end: without the checker's verdict the judge
// can only guess from the URL's shape, which is exactly the guessing the
// factual-error guard tells it not to do.
test('a broken destination carries the checker verdict into the bundle', () => {
  const out = buildBundle([page()], [
    { url: 'https://www.quiz.example.com//default', status: 'dead_domain' },
  ]);
  assert.match(out, /\[BROKEN: the domain does not resolve\]/);
});

test('404 and 410 are named by their status', () => {
  const out = buildBundle([page()], [
    { url: 'https://www.quiz.example.com//default', status: 404 },
  ]);
  assert.match(out, /\[BROKEN: returns 404\]/);
});

test('a healthy link carries no verdict', () => {
  assert.ok(!/BROKEN/.test(buildBundle([page()])));
});

// The same destination under two labels is the inconsistency we want visible
// (propstrata: "Blog" pointed at /blog on one page and blog.propstrata.com on
// another), so labels are part of the dedupe key, not stripped by it.
test('the same href under two labels survives dedupe', () => {
  const out = linksBlock(page({
    links: [
      { href: 'https://example.com/x', label: 'Blog' },
      { href: 'https://example.com/x', label: 'News' },
      { href: 'https://example.com/x', label: 'Blog' },
    ],
  }));
  assert.match(out, /Blog -> https:\/\/example\.com\/x/);
  assert.match(out, /News -> https:\/\/example\.com\/x/);
  assert.equal((out.match(/Blog ->/g) || []).length, 1, 'exact repeats still collapse');
});

test('per-page link cap bounds the token cost', () => {
  const links = Array.from({ length: 200 }, (_, i) => ({ href: `https://example.com/${i}`, label: `L${i}` }));
  const out = linksBlock(page({ links }));
  assert.equal(out.split('\n').filter((l) => l.startsWith('  ')).length, 40);
});

test('icon links and javascript: hrefs do not become noise', () => {
  const out = linksBlock(page({
    links: [
      { href: 'https://example.com/a', label: '   ' },
      { href: 'javascript:void(0)', label: 'Menu' },
    ],
  }));
  assert.match(out, /\(no text\) -> https:\/\/example\.com\/a/);
  assert.ok(!/javascript:/.test(out));
});

test('a page with no links gets no links section at all', () => {
  assert.equal(linksBlock(page({ links: [] })), '');
});

// The bundle still leads with rendered visible text, so every quote the judge
// can cite is still gate-checkable against the same text.
test('page text still comes first and is unmodified', () => {
  const out = buildBundle([page({ text: 'Plans from 19 a month' })]);
  assert.match(out, /TITLE: Home\n\nPlans from 19 a month\nLINKS ON THIS PAGE/);
});

// Guard the deliberate non-addition. A heading with no body beneath it is NOT
// signalled: the apex FAQ proved that absence in one non-interactive render is
// not absence of content, and both of Notion's critical FPs were exactly that
// mistake.
test('the bundle never asserts that a section is empty', () => {
  const out = buildBundle([page({ text: 'What is X?\nWhat is Y?\n', links: [] })]);
  assert.ok(!/empty|no answer|missing content/i.test(out));
});

// The quote gate builds bodyByUrl from p.text ONLY (run-pipeline.mjs:474), so a
// quote lifted from the LINKS block fails the gate by construction. That is the
// safety property that lets destinations enter evidence at all: the judge
// cannot fabricate a quote out of a URL and ship it. The workable path is that
// anchor TEXT is rendered visible text, so it is already in p.text and quotes
// fine; the destination belongs in `issue`. The prompt says exactly this.
test('link text lives in page text, so a link finding is still gate-checkable', () => {
  const p = page({ text: 'Take the quiz today.' });
  const out = buildBundle([p]);
  const linkLine = out.split('\n').find((l) => l.includes('->'));
  assert.ok(linkLine, 'a links section exists');
  assert.ok(!p.text.includes(linkLine.trim()), 'the -> line is NOT in page text: gate would reject it');
  assert.ok(p.text.includes('Take the quiz'), 'the anchor text IS in page text: gate accepts it');
});
