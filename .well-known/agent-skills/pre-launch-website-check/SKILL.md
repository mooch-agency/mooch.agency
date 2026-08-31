---
name: pre-launch-website-check
description: Pre-launch website check for marketing and brand sites. Two modes. "check" crawls the site, runs 10 discipline audits in parallel, and returns a pass/fail report grouped by severity. "apply" does the same audit, then fixes safe items and flags the rest. Use when asked to "run a pre-launch check on [site]", "audit [site]", "check [site] before launch", or "run best practices on [site]". Works on any static or server-rendered site with a public URL or local repo.
user-invocable: true
---

<!-- moochbot byline: built and maintained by Moochbot for mooch.agency. -->

A pre-launch health check for marketing and brand sites: audit 10 disciplines and either report or fix. Two modes: check (report) and apply (fix safe items, flag the rest).

## How to invoke

```
/pre-launch-website-check check [site-or-repo-path]
/pre-launch-website-check apply [site-or-repo-path]
```

- `check`: audit only. Returns a structured report, changes nothing.
- `apply`: audit, then fix safe items in the working tree. Flags unsafe items for manual review.

If the argument is a URL, run the remote checks (Lighthouse, linkinator, live headers). If it's a local path, also run file-level checks (hardcoded tokens, missing alt text in source, etc.). If both a URL and a repo path are available (e.g. a Vercel site with a local checkout), use both.

## Prerequisites

These run via `npx` (no global install needed):
- `lighthouse` (performance, accessibility, SEO scoring)
- `linkinator` (broken link detection)
- `html-validate` (HTML validation)

If a tool is unavailable or fails, log the failure and continue with the remaining checks. No single tool failure should block the audit.

## Workflow

### Phase 1: Discover

1. Identify the site. If a repo path is given, read `sitemap.xml` (or equivalent) to build the page list. If a URL is given, fetch `/sitemap.xml`. Fall back to crawling the homepage for internal links.
2. Read the project's `CLAUDE.md`, `tokens.css`, `ui.css`, or equivalent design-system files if a repo path is available. These inform the design-system conformance check.
3. Build a page manifest: list of URLs to audit, plus local file paths if available.

### Phase 2: Check (10 disciplines, parallel)

Run 1 agent per discipline. Each agent returns a JSON array of findings:

```json
[
  {
    "discipline": "seo-meta",
    "item": "Missing canonical on /about",
    "severity": "high",
    "auto_fixable": true,
    "fix_description": "Add <link rel='canonical' href='https://example.com/about'> to <head>",
    "file": "about.html",
    "line": null
  }
]
```

Severity levels: `critical`, `high`, `medium`, `low`, `info`.

`auto_fixable`: true only when the fix is safe, reversible, and unambiguous. When in doubt, false.

#### Discipline 1: SEO and meta

What to check:
- Every page has a unique `<title>` (50-60 chars) and `<meta name="description">` (120-160 chars).
- Every page has `<link rel="canonical">` pointing to itself.
- OG and Twitter meta tags present: `og:title`, `og:description`, `og:image`, `og:url`, `twitter:card`.
- `sitemap.xml` exists and every page in the sitemap resolves (200). Every public page in the repo is in the sitemap.
- `robots.txt` exists and is valid.
- `llms.txt` exists (for AI discoverability).
- No broken internal links. Run: `npx linkinator [url] --recurse --skip "^(?!https?://[site-domain])" --format json`.
- Draft/staging pages have `<meta name="robots" content="noindex">`.
- Favicons present: `favicon.ico` or `favicon.svg`, plus `apple-touch-icon`.

Auto-fixable: missing canonical, missing OG tags (can generate from title/description), adding pages to sitemap, adding `llms.txt` stub.
Not auto-fixable: broken external links, content rewrites for title/description length.

#### Discipline 2: Accessibility

What to check:
- Focus rings visible (not `outline: none` without a replacement).
- `prefers-reduced-motion` media query present for any CSS animations/transitions.
- Heading order: no skipped levels (h1 to h3 without h2).
- Colour contrast: check via Lighthouse accessibility audit.
- Every `<img>` has `alt` text (empty `alt=""` acceptable only for decorative images).
- Run: `npx lighthouse [url] --only-categories=accessibility --output=json --chrome-flags="--headless --no-sandbox"`.

Auto-fixable: adding `alt=""` to decorative images if context is clear, adding `prefers-reduced-motion` wrapper.
Not auto-fixable: choosing alt text for meaningful images, fixing colour contrast (requires design decisions).

#### Discipline 3: Performance

What to check:
- Lighthouse performance score. Budget: >= 90 on mobile.
- Largest Contentful Paint < 2.5s, First Input Delay < 100ms, Cumulative Layout Shift < 0.1.
- Images optimised (no uncompressed PNGs > 200KB served where WebP/AVIF would do).
- No render-blocking resources that could be deferred.
- Run: `npx lighthouse [url] --only-categories=performance --output=json --chrome-flags="--headless --no-sandbox"`.

Auto-fixable: adding `loading="lazy"` to below-fold images, adding `decoding="async"`.
Not auto-fixable: image format conversion, code splitting, server config changes.

#### Discipline 4: Design-system conformance

What to check (requires repo access):
- No hardcoded colour values in HTML files that should use CSS custom properties from `tokens.css` (or the project's token file).
- No hardcoded font sizes, spacing values, or timing values that exist as tokens.
- Shared button classes used consistently (no one-off button styles that duplicate existing components).
- Motion patterns use shared classes/JS, not inline animation code.
- Any new component added on 3+ pages should be promoted to shared CSS.

Auto-fixable: replacing hardcoded hex values with `var(--token-name)` when a matching token exists.
Not auto-fixable: creating new tokens, promoting components to shared CSS (requires design review).

#### Discipline 5: Security headers and secrets

What to check:
- Site served over HTTPS (no mixed content).
- HSTS header present (`Strict-Transport-Security`).
- Basic CSP header present (`Content-Security-Policy`), at minimum `default-src`.
- No API keys, tokens, or secrets in client-side JavaScript or HTML source. Grep for common patterns: `sk-`, `ghp_`, `AIza`, `Bearer `, `api_key=`, `token=` in source files.
- `npm audit` (if `package.json` exists) reports no critical vulnerabilities.
- `X-Content-Type-Options: nosniff` header present.
- `X-Frame-Options` or CSP `frame-ancestors` set.

Auto-fixable: adding security headers via `vercel.json` or middleware (if the project uses Vercel).
Not auto-fixable: fixing npm vulnerabilities (requires dependency decisions), removing leaked secrets (requires rotation).

#### Discipline 6: Privacy and consent

What to check:
- If the site sets cookies, a cookie/consent banner is present.
- Privacy policy page exists and is linked from the footer.
- Third-party scripts disclosed: list all external script sources (`<script src="...">` pointing to third-party domains).
- No PII in URL parameters or query strings.
- GDPR posture: if the site targets EU users, data processing basis should be stated.

Auto-fixable: adding a privacy policy link to the footer (if a privacy page exists but isn't linked).
Not auto-fixable: writing a privacy policy, implementing a consent banner, removing third-party scripts.

#### Discipline 7: Content hygiene

What to check:
- No "Lorem ipsum" or common placeholder text.
- No "TODO", "FIXME", "PLACEHOLDER", "TBD" in visible page content (code comments are fine).
- Copyright year is current (2026) or uses a dynamic range.
- No broken images (`<img>` tags where the `src` returns 404).
- No empty links (`<a>` with no `href` or `href="#"`).
- No duplicate page titles across the site.

Auto-fixable: updating copyright year, removing placeholder text if the replacement is obvious.
Not auto-fixable: writing real copy to replace placeholders, fixing broken image sources.

#### Discipline 8: Mobile and responsive

What to check:
- `<meta name="viewport" content="width=device-width, initial-scale=1">` present.
- Touch targets >= 44x44px (check via Lighthouse).
- No horizontal scroll on mobile (check via Lighthouse mobile audit).
- Images use `srcset` or CSS responsive techniques for different screen sizes.
- Text readable without zooming (minimum 16px body text).

Auto-fixable: adding viewport meta tag.
Not auto-fixable: resizing touch targets, implementing responsive images (requires design decisions).

#### Discipline 9: Trust and contactability

What to check:
- Footer present with: company name, contact method (email or phone), and at least 1 social link.
- `mailto:` links are valid (well-formed email address).
- `tel:` links are valid (well-formed phone number).
- Social media links resolve (don't 404). Check the top 3.
- About page or team section exists and is linked from the nav or footer.

Auto-fixable: fixing malformed mailto/tel links.
Not auto-fixable: adding missing contact info, creating an about page.

#### Discipline 10: Analytics and events

What to check:
- Vercel Analytics script present (`@vercel/analytics` or the `<script>` tag equivalent).
- Vercel Speed Insights present (`@vercel/speed-insights` or the script tag).
- If analytics scripts are present, check they're not blocked by CSP or consent gates (unless consent-gating is intentional).
- No PII in analytics event payloads (grep for email patterns, phone numbers in `track()` calls).
- Custom events firing on key interactions (forms, CTAs, outbound links). Check the source for `track()` or equivalent calls.
- If the site is not on Vercel, check for an equivalent analytics setup (GA4, Plausible, Fathom, etc.).

Auto-fixable: adding Vercel Analytics/Speed Insights script tags.
Not auto-fixable: configuring custom events, consent-gating analytics, verifying dashboard data flows (that's a `[MANUAL]` check).

### Phase 3: Synthesise

1. Merge all 10 agents' findings into a single report.
2. Group by severity (critical first, then high, medium, low, info).
3. Within each severity, group by discipline.
4. Summary stats: total findings, pass/fail per discipline, auto-fixable count.
5. Output format: structured markdown report.

Report template:

```markdown
# Pre-Launch Website Check: [site]

**Date:** [date]
**Mode:** check | apply
**Pages audited:** [count]

## Summary

| Discipline | Status | Findings |
| --- | --- | --- |
| SEO/meta | PASS/FAIL | 3 issues (1 high, 2 medium) |
| ... | ... | ... |

**Total:** [n] findings ([x] critical, [y] high, [z] medium, [w] low, [v] info)
**Auto-fixable:** [n] items

## Critical

### [Discipline]: [Item]
- **File:** `path/to/file.html` (line N)
- **Fix:** Description of what to do.
- **Auto-fixable:** Yes/No

## High
...

## Medium
...

## Low
...

## Info
...
```

### Phase 4: Apply (apply mode only)

1. For each finding where `auto_fixable` is true:
   a. Make the fix in the working tree.
   b. Log the change (file, line, what changed).
2. Group changes into logical commits (1 per discipline, or fewer if changes are small).
3. Do NOT commit or push. Leave changes staged for review.
4. Update the report: mark applied items as "APPLIED" and remaining items as "MANUAL".

## Safety rules

- Never delete files. Only add or modify.
- Never rewrite user-authored copy (headlines, body text, marketing language). Content hygiene flags placeholder text, it doesn't rewrite real content.
- Never change visual design (colours, layout, typography) without explicit token mappings.
- Never modify JavaScript logic. Only add attributes or meta tags to HTML.
- Never remove existing functionality (scripts, event handlers, third-party integrations).
- If a fix touches more than 5 lines in a single file, flag it as manual instead of auto-fixing.
- Always preserve the existing code style (indentation, quote style, attribute order).

## Adapting to other sites

This skill is generic. It works on any static or server-rendered marketing/brand site. Project-specific details (token file names, analytics provider, deployment platform) are discovered in Phase 1 from the project's `CLAUDE.md`, `package.json`, and file structure. No Mooch-specific assumptions are hardcoded.

For non-Vercel sites: skip Vercel-specific checks (Vercel Analytics, Speed Insights, `vercel.json` headers) and substitute the equivalent for the detected platform.
