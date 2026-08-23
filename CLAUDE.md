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

Every public page ships its own share card. Add a `card` block to
`mooch-cards/og-site.sh`, run `./og-site.sh`, copy `out/site/<slug>.png` to
`og-<slug>.png` in the repo root, and point the page's `og:image` /
`twitter:image` at it (with width, height and alt). `og-image.png` is the brand
card and the fallback only.

## Voice
British English, terse, no em dashes. Full house style: MOOCHBOT.md in Notion.

## Privacy
Don't commit Tahi's personal email address anywhere: repo docs, code, or commit
metadata. Commit as `Claude <noreply@anthropic.com>`. The brand and public
contact (the business email, social handles, the husband-and-wife framing) are
intentional and stay.
