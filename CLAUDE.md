# mooch.agency

Static HTML site. No build step, no framework. Each page is a standalone `.html`
served as-is (Vercel, `cleanUrls`). Shared styling lives in 4 root files; anything
page-specific stays inline in that page's `<style>`.

## Design system

Before building any UI, read `tokens.css`, `ui.css` and `styleguide.html`, and
reuse what's there before inventing anything new.

- `tokens.css` colour, type, spacing, motion timing. Never hardcode a colour, size
  or duration in a page. A new value goes here first, even on its first use. This
  is the rule that stops drift.
- `motion.css` entrance motion (`.reveal`, word stagger, `.rise`) plus the
  reduced-motion guards.
- `ui.css` buttons (`.pill`, `.ghost`).
- `motion.js` declarative entrances (`data-stagger`, `data-reveal`), loaded by the
  homepage only.

Full reference: `docs/design-system.md`. Rendered, living version: `/styleguide`.

### Adding a component
- One-off: keep it inline on the page.
- Reused: on the second or third use, promote it into shared CSS and use the class
  everywhere (rule of three).
- When you promote something to shared CSS, add it to `styleguide.html` in the same
  commit, so the guide stays a mirror of what actually ships. Don't add page-local
  one-offs to the styleguide.

### New page
Copy `case-study-template.html` (or `index.html`). Keep the shared `<link>`s in the
head, in order: `tokens.css`, then `motion.css`, then `ui.css`. Add `motion.js`
before `</body>` only if the page uses `data-reveal` / `data-stagger`. Put only
page-specific layout in the inline `<style>`. Add public pages to `sitemap.xml` and
`llms.txt`.

Every public page ships its own share card, and **creating it is part of
creating the page, never a separate ask**: whoever builds a page (usually
Claude) adds a `card` block to `mooch-cards/og-site.sh` in the same change, with
eyebrow/title/subtitle drawn from the page's own hero copy, runs `pnpm
cards:build`, and points the page's `og:image` / `twitter:image` at the card
(with width, height and alt). Tahi and Natalie never do this by hand.

`pnpm cards:build` renders every card straight to its `og-<slug>.png` in the
repo root and stamps the URLs, so there is no copy step. CI is the safety net,
not the instructions: `check-site` fails a shipped page without a resolving
`og:image`, and `stamp-cards --check` fails a stale or missing stamp, so a page
cannot ship cardless or stale even if this paragraph is ignored. First run
needs the renderer's deps (`cd mooch-cards && pnpm install`); to eyeball a card
before it lands, `./mooch-cards/og-site.sh /tmp/preview`. `og-image.png` is the
brand card and the fallback only.

`mooch-cards/` here is a vendored copy of the renderer from the private
mooch-cards repo, which Natalie also uses for brand assets. The split is by
ownership: **card definitions live only here** (`og-site.sh` is site content and
versions with the pages), **brand assets live only there**. The renderer exists
in both on purpose, which pins the site's cards to a known engine and keeps them
reproducible from this repo alone. To take a rendering improvement, copy the
changed file across deliberately.

Then run `pnpm cards:stamp`. Card URLs carry a `?v=<content-hash>` stamp, because
Telegram, X and LinkedIn cache preview images by URL and never revalidate one they
have already fetched. Reusing a filename for new artwork is how the site ended up
serving a card from months earlier on every platform at once. The stamp makes a
redesigned card a new URL, so this cannot recur, and `pnpm ci:check` fails on a
stale stamp.

Retiring a card: never let its URL start 404ing. Add a redirect in `vercel.json`
so snapshots cached elsewhere resolve to something current, then the file itself
can go (Vercel matches redirects before the filesystem, so the redirect works
either way). Point the destination at a card, not at a bare filename: `cards:stamp`
stamps redirect destinations too, precisely so a retired URL cannot hand a crawler
back the unstamped key it was already caching.

## Voice
British English, terse, no em dashes. Full house style: MOOCHBOT.md in Notion.

## Privacy
Don't commit Tahi's personal email address anywhere: repo docs, code, or commit
metadata. Commit as `Claude <noreply@anthropic.com>`. The brand and public
contact (the business email, social handles, the husband-and-wife framing) are
intentional and stay.
