// The websearch-method audit prompt.
//
// Provenance: this is the `content-audit` skill (the cold-outreach taster, the
// "Notion skill" in benchmark/2026-07-30-baseline.md) capped to 5 pages, with the
// output contract the code gate and the record writer need bolted on. It is NOT
// derived from the pipeline's judge prompt: the whole point of the experiment is
// that the Notion skill's instructions are the ones under test.
//
// Two deltas from the Notion skill, both forced by the tool swap:
//
// 1. The Notion skill reads with a rendering browser. Here the only reader is
//    WebFetch, which converts raw HTML to markdown. That makes `display:none`
//    content VISIBLE to the auditor and invisible to the user -> the exact false
//    positive class the mooch-content-audit skill banned scrapers over (tability's
//    hidden pricing calculator). The prompt warns about it; the code gate, which
//    reads rendered innerText through a real browser, is what actually enforces it.
// 2. WebFetch executes no JS, so "this content is missing/empty" is unverifiable
//    here. Four of the six Notion false positives on the 30 Jul baseline were this
//    one class. Absence claims are therefore banned outright rather than guarded.

// `render` mode adds Tahi's second pass (31 Jul): the auditor drafts from WebFetch,
// then re-reads every page it intends to cite through a real rendering browser and
// reconciles the two readings itself. That converts the gate's binary drop into
// something the auditor can reason about, and it is the only way the absence class
// becomes reportable at all. The cost is stated plainly on the record: in this mode
// the auditor and the gate share an instrument, so the gate stops being an
// independent check and degrades to a hallucination check.

// `notionShape` is the faithful reproduction and the one that matters: WebSearch for
// discovery, a rendering reader for pages, and no WebFetch anywhere.
//
// WebFetch was a mistake in arms A and B. The brief said "using websearch", headless
// `claude -p` offers WebSearch and WebFetch, and WebFetch got drafted as the page
// reader without being checked against `web.loadPage`. They are not the same
// instrument and are close to opposites: `web.loadPage` returns rendered text and
// explicitly no raw HTML, while WebFetch returns raw HTML converted to markdown and
// then passed through a summarising model. So WebFetch sees hidden markup the user
// never sees, cannot see anything JavaScript renders, and rewrites the quotes that
// are the entire deliverable. Arm A shipped 0 findings across 6 sites on that.
export function buildPrompt({ site, pages = 5, render = false, renderCmd = '', notionShape = false }) {
  return `Run a content audit on ${site}. You are auditing a real prospect's live website; the report goes to them.

## The goal

Every audit either surfaces at least one finding the prospect would act on, or says plainly that it couldn't. This is not a complete audit, it is a credible sample: they read it, find something real, think "what else is wrong?", and get in touch.

A missed finding that would have made them call is the expensive failure. A false all-clear ("your site's in good shape" when you simply couldn't read it) is the second expensive failure. Low-severity trivia is not the point and does not rescue a run.

## Tools

${notionShape
  ? `Two, mirroring the Notion skill's \`web.search\` + \`web.loadPage\` exactly.

**WebSearch** for discovery. It returns snippets (URL, title, extract). It never loads a page.

**The page reader**, for everything you actually audit:

\`\`\`
${renderCmd} "<url>"
\`\`\`

That is \`web.loadPage\` with \`fast_mode: false\`: the page's visible text after JavaScript has run, exactly as a real user sees it. Slow, 5-15s a page. It is the only reader you have and the only shell command that will run.

Like \`web.loadPage\`, it gives you **no raw HTML**. You cannot see meta tags, alt text, headings, structured data, or anything \`display:none\`. That is a feature: you only ever see what a user sees, so you cannot invent a finding out of hidden markup. Do not audit anything HTML-level; you have no view of it.`
  : render
  ? `WebSearch and WebFetch for the first pass, plus one shell command for the second:

\`\`\`
${renderCmd} "<url>"
\`\`\`

That returns the page's visible text exactly as a real browser renders it, after JavaScript has run. It is slow (5-15s a page) and it is the ground truth about what a user can see. It is the ONLY shell command available to you; nothing else will run.`
  : `You have exactly two: WebSearch and WebFetch. No browser, no scraper, no shell.`}

### Discovery (WebSearch, no page-picking model)

Run 2-3 searches to build a page inventory:
- \`site:${hostOf(site)}\`
- \`site:${hostOf(site)} pricing OR plans OR services OR shop OR booking\`
- \`site:${hostOf(site)} about OR team OR contact OR FAQ\`

From the results, pick the pages yourself. Priority: homepage → the page where money is made (pricing / services / shop / booking) → trust or conversion page (about / contact / terms / donate) → FAQ or support → a location or product page. Judgement beats the list: take the pages most likely to hold something a prospect would act on.

### Reading (${notionShape ? "the page reader" : "WebFetch"})

**Budget: the homepage plus up to ${pages - 1} more pages, ${pages} total.** Read them all before you judge anything. Cross-page comparison is the product; you are holding all ${pages} pages at once and nothing else can do that.

You may additionally ${notionShape ? 'read' : 'WebFetch'} a handful of internal link destinations to check where they actually land. Those do not count against the ${pages}-page budget, but keep it to about 8 and only for links whose destination is in question.
${notionShape ? `
## The one trap in a rendered reader

You see what a user sees, which removes the hidden-markup problem entirely. What it does not remove is **content that only appears on interaction**: accordion answers that mount on click, inactive tabs, modals, anything behind a control you cannot press. Your reader loads and scrolls; it does not click.

So a thin-looking FAQ is not an empty FAQ, and a section you cannot find is not a missing section. Before reporting that anything is absent, missing, empty or broken, establish what that site's genuine "not found" state looks like — fetch a URL you invented, see what comes back, and compare. Absence is reportable here, but only against a control.

Also: if a number is animating, a testimonial is rotating, or a feed is live, whatever your reader caught is one frame of it, not a fact. Do not quote it.
` : `
## What WebFetch gives you, and the two traps in it`}

${notionShape ? '' : `WebFetch converts the page's raw HTML to markdown. It does not run JavaScript and it does not know what is visible.`}

${notionShape ? "" : `**Trap 1 — hidden content.** Text that is \`display:none\`, inside a collapsed accordion, in a hidden modal, or in an inactive tab arrives in your fetch looking exactly like body copy. Real users never see it. Flagging it is the single most common way this method produces a false positive. If a price, a claim or a heading only makes sense as part of a widget, a calculator, a toggle or an alternate tab state, treat it as invisible and do not flag it.`}

${notionShape ? "" : `**Trap 2 — absence.** You cannot see anything rendered by JavaScript after load: accordion answers that mount on click, tag lists, feeds, counters, carousels, anything hydrated client-side. So a WebFetch reading can never establish that content is missing, empty, broken, blank, "still loading" or "not implemented".`}

${notionShape ? "" : render
  ? `Both traps are what the second pass is for. Do not resolve either one from WebFetch alone.`
  : `**Do not report any finding whose claim is that something is absent.** If a page looks thin, that is your reader's limit, not the site's defect. Say so in the coverage note instead.

Everything you report must be a positive claim about text that is there.`}

## What to look for

Across and within the ${pages} pages:

- **Broken links and dead ends** — a link whose destination 404s, or lands somewhere the label did not promise ("Book Lisbon" → London). Fetch the destination before claiming this. Never flag an external link as broken: social and third-party sites block bots and a challenge page is not a 404.
- **Pricing inconsistencies** — the same product at different prices on different pages. Quote the exact figure, the exact billing period, the exact tier name. Annual-vs-monthly mislabels are a known way to get this wrong.
- **Contradictions across pages** — counts, names, dates, hours, claims that cannot both be true. Give both quotes.
- **Factual errors** — a named person given the wrong role, a wrong company, a wrong statistic, a miscited source. These are high-value: they are the findings a prospect cannot dismiss.
- **Naming inconsistencies** — the same product or service under two names.
- **Spelling and grammar** — real errors, not house style. American spelling on an American site is not an error.
- **Visible formatting artifacts** — escaped markdown, duplicated paragraphs, stray template syntax in body copy.
- **Stale content** — last year's copyright, a past date still described as upcoming, "coming soon" for something live.

## Judgement

Be confident on things you can verify. If one page says £35 and another says £25, that is a pricing inconsistency: report it, do not hedge it into a "possible discrepancy". Hedging is how a real finding becomes unreadable.

Be ruthless on things you cannot. Before every finding, name the innocent explanation and say what rules it out. If nothing rules it out, drop the finding and record it as rejected.

Specific declines, all learned from real false positives:
- "Including X and Y" signals examples, not an exhaustive list. It does not contradict a broader claim elsewhere.
- Intentional design choices, responsive duplicates, placeholder text inside interactive widgets: not issues.
- No HTML-level claims. You have no reliable view of meta tags, alt text, headings or structured data. Do not audit them.
- Consistent house style, even style you dislike, is not an error.
- If you are unsure whether a real user can see it, you already have your answer: do not report it.

One wrong finding costs more trust than five missed ones. But a report of nothing costs the whole audit, so do not use that as cover for timidity: it is a bar for evidence, not a bar for boldness.
${(render && !notionShape) ? `
## Second pass: render, then reconcile

Do this after you have a draft list of findings and before you write anything. It is not optional and it is the part of this method that earns its keep.

**Run \`${renderCmd} "<url>"\` on every page you intend to cite, and on every page where you rejected something for being unverifiable.** Then compare that rendered text against what WebFetch gave you for the same page, and settle each finding against these rules:

1. **Quote is in the rendered text too.** It is real and a user can see it. Keep the finding. This is also your licence to stop hedging.
2. **Quote is in WebFetch but NOT in the rendered text.** It is hidden markup, a collapsed panel, an inactive tab, or a template the site never shows. **Drop the finding.** A user never sees it, so it is not a defect. Put it in \`rejected\` with the reason "in source, not rendered".
3. **Quote differs between the two.** The rendered text wins, always. Re-quote from the rendered reading and re-check that the finding still stands against the real wording — often it will not.
4. **You suspected something was missing.** Now you can check. If the rendered text has it, JavaScript mounted it: not a finding, and say so in \`rejected\`. If the rendered text also lacks it, **you may now report absence**, because you have looked with the instrument that can see. This is the one class the first pass structurally cannot decide, and resolving it is most of the point.
5. **The rendered text shows something WebFetch never did.** New findings are allowed and welcome. Client-rendered pages hide most of their body copy from the first pass.
6. **The page will not render at all** (fetch error, bot challenge, empty). Do not treat that as absence and do not treat it as confirmation. Drop anything resting on it and name the page in \`coverage\`.

Record what this pass changed in the \`verified\` key of the summary block. A second pass that changed nothing on a client-rendered site almost certainly means you did not actually run it.
` : ''}
## Output

Return three things, in this order, and nothing after them.

### 1. The report

British English. Markdown. Structure:

A one-line summary sentence. Then a **Worst Offenders** table (up to 6 rows: Issue in bold | Detail with the verbatim quote and a clickable page link | Severity). Then category sections for whatever applies, max 3 columns each, every page reference a clickable \`[/path/](${site.replace(/\/$/, '')}/path/)\` link, no Fix column.

Severity: **Critical** broken functionality or misleading users; **High** stale content, pricing mismatches, factual errors; **Medium** naming, minor contradictions; **Low** style-grade.

If you found nothing material, say so in one line — and if any page failed to load, say plainly that this is not a clean bill of health.

### 2. The reasoning summary

A fenced block tagged \`summary\` containing JSON with exactly these keys:

\`\`\`summary
{
  "summary": "one line: N findings reported, M considered and rejected",
  "discovery": "how you found the pages and which URLs you read",
  "approach": "what you compared across the pages, and what you deliberately treated as unreadable",
  "kept": ["SEVERITY type /page: the innocent explanation you tested and what ruled it out", "..."],
  "rejected": ["what you considered and did not flag, and the one-line reason", "..."],${render ? `
  "verified": ["what the render pass changed: each finding it dropped, re-quoted, or newly revealed, and which rule decided it", "..."],` : ''}
  "coverage": "pages read, pages you could not read and why",
  "pages_read": ["https://…", "…"],
  "unread": [{"url": "https://…", "why": "one line: bot challenge, timeout, empty render"}]
}
\`\`\`

\`pages_read\` and \`unread\` are machine-read, not prose, and they decide what the client is told about scope. \`pages_read\` lists only pages you actually loaded and audited, full URLs, excluding link-destination checks. \`unread\` is every page you tried and failed to read; leave it \`[]\` if there were none. **If you could not read a page, it MUST appear in \`unread\`.** A report that says "we found nothing" when a page went unread is the single worst output this audit can produce, and that list is the only thing preventing it.

\`rejected\` is not optional and is not decoration. It is read by a human to spot an auditor gone too keen or too shy, so every non-obvious thing you looked at and let go belongs there.

### 3. The machine-readable findings

A fenced \`json\` block, last thing in your reply:

Findings come in two shapes, and using the wrong one is how a real finding gets thrown away.

**Shape 1 — something on the page is wrong.** The default. Evidence is a quote.

\`\`\`json
{"findings": [{"url": "https://…", "severity": "critical|high|medium|low", "type": "broken-link|pricing|contradiction|factual|naming|grammar|formatting|stale", "quote": "…", "quote2": "…", "url2": "https://…", "why": "one line"}]}
\`\`\`

\`quote\` must be copied character for character from ${notionShape ? `the page reader's output for \`url\`` : render ? `the **rendered** reading of \`url\` — the second pass's output, not WebFetch's` : `the text WebFetch returned for \`url\``}. Not paraphrased, not tidied, not re-punctuated. \`quote2\`/\`url2\` only on contradictions, carrying the other side.

**Shape 2 — something that should be there isn't.** A page with no content, a policy that doesn't exist, a nav link to nothing. Use \`absence_claim\` and **no quote**:

\`\`\`json
{"url": "https://…", "severity": "…", "type": "broken-link", "absence_claim": "missing|empty|wrong_page", "evidence_note": "one plain sentence describing what the page actually renders", "why": "one line"}
\`\`\`

- \`missing\` — the URL doesn't exist; it serves the site's not-found state.
- \`empty\` — the page exists and renders no real content (shell, nav and footer only, or stuck loading).
- \`wrong_page\` — it renders a real page, but not the one the link promised.

\`evidence_note\` is shown to the client in place of a quotation, so write it as an observation of what is there ("Renders only the navigation and footer, with no contact form"), never as a quote.

Pick the right one. Code checks which it actually is, by requesting a URL that cannot exist to learn this site's genuine not-found state and comparing. Claiming \`missing\` for a page that really renders the product page is a fail even though something is genuinely broken.

**Never prove an absence with a quote.** The tempting move is to quote the loading message ("Loading tags..."). Don't: a loading message is by definition a thing that goes away, so it is not stable evidence and the check will drop the whole finding. Use \`absence_claim\` and let the code establish it.

**Every quote is checked by code against the page as a real browser renders it.** A quote that does not appear there is dropped, whether it was hallucinated, silently reworded, or lifted from hidden markup. Copy exactly, and quote only text a user can actually see.

Begin.`;
}

function hostOf(site) {
  try { return new URL(site).hostname.replace(/^www\./, ''); } catch { return site; }
}
