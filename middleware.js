// ---------------------------------------------------------------------------
// middleware.js: Markdown for agents (content negotiation).
//
// When a request for a page asks for `Accept: text/markdown`, serve that page's
// Markdown copy (md/<slug>.md) instead of the HTML. Everyone else gets the page
// as normal. This is the check Cloudflare's agent-readiness scan calls
// "Markdown for Agents"; without it mooch.agency sat at 2/5 on the very scan
// AXBeat publishes.
//
// Why middleware and not a vercel.json rewrite: Vercel serves an existing file
// before it applies rewrites, and every page here is an existing .html file,
// so a header-matched rewrite would never fire. Routing Middleware runs first.
//
// The copies are generated and committed by scripts/markdown-pages.mjs, which
// also writes md/slugs.js; only those slugs are rewritten, so an unknown path
// asked for as Markdown falls through to the normal 404 rather than a broken
// rewrite. Both pages and the Markdown copies send `Vary: Accept`, so a cache
// never hands a browser the Markdown or an agent the HTML.
// ---------------------------------------------------------------------------

import { next, rewrite } from '@vercel/functions';
import slugs from './md/slugs.js';

const PAGES = new Set(slugs);

export const config = {
  // Page paths only: no file extensions, no API routes, nothing already in md/
  // or .well-known/. Assets never reach this function.
  matcher: ['/', '/((?!api/|md/|\\.well-known/)[^.]*)'],
};

export default function middleware(request) {
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/+|\/+$/g, '');
  const wantsMarkdown = /\btext\/markdown\b/i.test(request.headers.get('accept') || '');

  if (wantsMarkdown && PAGES.has(slug)) {
    return rewrite(new URL(`/md/${slug === '' ? 'index' : slug}.md`, request.url), {
      headers: { 'content-type': 'text/markdown; charset=utf-8', vary: 'Accept' },
    });
  }
  return next({ headers: { vary: 'Accept' } });
}
