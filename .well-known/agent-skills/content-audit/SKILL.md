---
name: content-audit
description: Run a content audit on any public website. Browse the live site, find real issues (broken links, pricing inconsistencies, contradictions, stale content), and return a formatted report the client can act on. Designed as a free taster audit for prospective clients. Use when asked to "run a content audit on [domain]" or "audit [domain] for content issues".
user-invocable: true
---

<!-- moochbot byline: built and maintained by Moochbot for mooch.agency. -->

Run a content audit on any public website. Browse the live site, find real issues, return a formatted report the client can act on. Designed as a free taster audit for prospective clients.

## How to invoke

The user says: "Run a content audit on [domain]" or "Audit [domain] for content issues."

Run the audit, create a new page with the report, and link it in chat.

## Tools and strategy

### Discovery: web search

Search with the target domain to discover pages on the site. Run 2-3 queries to build a sitemap:
- `site:domain.com` (general discovery)
- `site:domain.com pricing OR plans OR products` (commercial pages)
- `site:domain.com about OR team OR contact OR FAQ` (info pages)

From the results, build a priority list of 15-20 pages to audit. Prioritise:
1. Homepage
2. Product / service pages (where money is made)
3. Pricing / plans pages
4. Location pages (if multi-location business)
5. FAQ / support pages
6. About / team / story pages
7. Contact page
8. Blog (sample 1-2 recent posts only)

### Page loading

**Always try fast mode first.** If it returns fewer than 30 lines or only nav / footer shells, the site is JS-rendered. Switch to slow mode (full rendered content, up to 1 minute per page). Slow mode is the primary audit source.

**Pagination:** if a page is truncated, load the next portion. Always check the total line count against what you received.

**Budget:** aim for 12-18 pages loaded in slow mode per audit. This covers most SMB sites. For larger sites, prioritise by page type above.

### Cross-referencing

After loading pages, cross-reference:
- Navigation links against actual page content (does the nav say £35 but the page says £25?)
- CTAs and buttons against their destination URLs (does "Book Lisbon" link to London?)
- Product names across pages ("Roaming Desk" vs "Roaming Membership")
- Claims on one page vs contradictions on another

### What the tools can't do

- **No raw HTML access.** Can't check meta tags, robots directives, structured data, or HTML-level formatting. Note this as a limitation under "Also Noted" if relevant.
- **No visual rendering.** Can't verify CSS layout, responsive design, or visual hierarchy. If the text content suggests a formatting issue (escaped markdown, duplicated text), flag it but note it needs visual verification.
- **No auth-gated content.** Member areas, dashboards, admin panels are out of scope.

## Output template

Create a new page titled `[Business Name] Content Audit`. Use the 📋 icon. Parent it under the relevant project or client page.

### Page structure

Open with a one-line summary quote block that includes the fix estimate:

> We ran a content audit across [domain] and found [X] issues worth bringing to your attention: [top 2-3 issue types]. **We can fix everything here in [X-X] days.**

Calculate X using: critical / high issues × 0.5 days, medium × 0.25 days, round up to nearest half-day. No separate soft-sell line. The findings table below does the selling.

Then a divider, followed by these sections in order:

### 1. Worst Offenders (always include)

A summary table of the 4-6 most impactful issues. This is the executive summary. Each row: Issue name (bold), Detail (one sentence), Severity (colour-coded).

| Issue | Detail | Severity |
| --- | --- | --- |
| **Example issue** | `/affected-page` brief description of what's wrong. Quote the exact text. | Critical |

### 2. Category sections (flexible, include only what applies)

Use whichever of these sections the site needs. Don't force empty sections. Every site is different.

- **Broken Links & Dead Ends**: links that go nowhere, go to the wrong place, or have stale dates.
- **Pricing Inconsistencies**: same product, different prices on different pages.
- **Contradictions**: Page A says X, Page B says Y. Two formats work: the standard 3-col (Page / Detail / Severity) when contradictions are scattered, or a comparison table (Issue / Page A says / Page B says) when listing direct face-offs. Pick whichever reads cleaner.
- **Naming Inconsistencies**: same thing called different names across the site.
- **Spelling & Grammar**: typos, misspellings, grammatical errors.
- **Formatting Issues**: visible markdown artifacts, duplicated text, broken rendering.
- **Stale / Outdated Content**: old dates, "coming soon" for things already live, dormant blogs.

**Table format rules:**
- **Max 3 columns.** No exceptions. No Fix column.
- Most category tables use: **Page** (with clickable link), **Detail** (bold lead-in sentence, then evidence), **Severity** (colour-coded).
- Spelling & Grammar tables use 2 columns: **Page** (with clickable link), **Issue** (bold error, then context). No severity column needed.
- **Every page reference must be a clickable link.** Format: `[/page-path/](https://domain.com/page-path/)`. This applies in the Page column, in Detail text, and in the Worst Offenders table. No bare paths. Ever.
- Merge Issue + Detail into a single Detail cell with a bold lead-in sentence followed by the evidence. Don't split across 2 columns.

### 3. Also Noted (always include)

Lower-priority observations and strategic notes. Bullet list. **Every bullet must be something worth fixing or thinking about.** Don't note things that are fine. "Articles section is active and current" or "Contact forms appear on every page, good practice" add nothing to a taster audit designed to win work. If it's not broken, missing, or a missed opportunity, leave it out.

### 4. Contact footer (always include)

A short invitation line followed by the sender's name and email. Warm, zero pressure.

> Once you're ready to talk, drop me an email.
>
> [Name]
> [email]
> mooch.agency

## Severity system

Use colour-coded cells in all tables:
- **Critical** (red): broken functionality, wrong destinations, contradictions that mislead users or cost money. Things the client would want fixed today.
- **High** (orange): stale content, pricing mismatches, significant inconsistencies. Things that erode trust or confuse users.
- **Medium** (yellow): naming inconsistencies, minor contradictions, generic links. Things worth fixing in a content pass.
- **Low** (gray): minor style preferences, capitalisation inconsistencies, wrong link destinations on low-traffic pages. Fix when you're in there anyway.

In the Worst Offenders table, colour the severity cell. In category tables, colour the severity cell for Critical and High rows. Medium and Low can be plain text.

## Rules

- **Every issue needs evidence.** Quote the exact text, name the exact page, show the exact URL. No vague claims.
- **No Fix column.** The report identifies problems. The fix conversation happens in person. This keeps tables scannable and under 3 columns.
- **Don't flag intentional design choices as issues.** Responsive duplicates, CSS-hidden elements, placeholder text in interactive widgets: not issues.
- **Don't flag things you can't verify.** If you can't see the raw HTML, don't claim there's a meta tag problem. Note it as a limitation.
- **Be confident on things you can verify.** If the nav says £35 and the page says £25, that's a pricing inconsistency. Don't hedge.
- **Consistent items get a row too.** In pricing comparison tables, show products where prices match (marked "Consistent. No action."). This proves thoroughness and builds trust.
- **Pricing comparison tables: max 3 columns.** Don't add a column per source. Use rows instead. If 3+ sources disagree, list them in the Detail cell rather than adding columns.
- **Every page reference is a clickable link.** `[/page-path/](https://domain.com/page-path/)` format. Every table, every section, every mention. No exceptions.
- **Don't pad the report.** If a site only has 8 real issues, report 8. A short, accurate report beats a long one full of noise.
- **British English** in all report copy.
- **No agency branding in the report body.** The report speaks for itself. Contact footer only.

## Content access and limitations

The main risk is **JS rendering**, not bot protection. Sites built as SPAs (React, heavy client-rendered Next.js) often return near-empty shells in fast mode: just the nav skeleton. The page content is rendered client-side and fast mode doesn't execute JS.

### How to tell the difference

- **JS rendering issue:** fast mode returns 10-30 lines of nav / footer with no body content, and the tool thinks it got everything. Fix: switch to slow mode.
- **Bot protection:** the page returns a challenge ("Please verify you are human", "Checking your browser", "Access denied"), an HTTP error, or completely empty text. Slow mode returns the same. Search also returns thin or no results for the domain.
- **Rate limiting:** first few pages load fine, then subsequent loads start returning errors or empty content. Space out requests or reduce page count.

### When you hit a wall

1. Fast mode thin: try slow mode. Fixes 90%+ of cases.
2. Slow mode also fails: try search with a domain filter to get content snippets. Often enough for cross-page contradiction and naming checks.
3. Both fail: flag it. Don't guess. Note which pages loaded and which didn't. The audit can still run on whatever loaded, with a caveat.
4. Don't power through with bad data. A partial audit with a coverage caveat beats a full audit built on empty pages.

## What success looks like

The report should make the client think: "They found things we didn't know about." It's a demonstration of competence, not a sales pitch. The fixes happen in the follow-up conversation, not the report.
