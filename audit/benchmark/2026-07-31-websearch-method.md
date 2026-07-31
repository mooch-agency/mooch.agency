# Websearch method vs the pipeline

**Run date:** 31 Jul 2026
**Branch:** `audit/websearch-method`
**Auditor model:** Claude Sonnet 5, headless `claude -p`, subscription engine ($0 marginal)
**Pipeline baseline:** the 31 Jul single-pass `goal-*` runs in `2026-07-30-baseline.md`, plus a
fresh `goal-jackpotter` run for the one lead that file never covered.

## The question

Can the `content-audit` skill's instructions — the flexible, judgement-led "Notion skill"
that reads with a browser and picks its own pages — replace the pipeline's picker →
prefetch → judge → consensus machinery, if the code gate is kept as the verifier?

Capped to 5 pages, so page budget is not the variable. No picker model, no puppeteer
prefetch stage, no link crawler, no multi-pass consensus, no thin-report floor.

## Arms

| Arm | Reader | Verifier | Rationale |
|---|---|---|---|
| Pipeline | puppeteer prefetch (`read-url.mjs` routine) | `code-gate.mjs` | The incumbent |
| **A** | WebSearch + WebFetch only | `code-gate.mjs` | Gate stays independent of the reader |
| **B** | A, then re-read cited pages via `read-url.mjs` and reconcile | `code-gate.mjs` | Tahi's two-pass proposal: draft cheap, verify with a real browser |
| **C** | B, but with `render-read.mjs` (settle-aware) | `code-gate-stable.mjs` (two captures) | B's two failure modes fixed |

Arm A exists to test a real argument, not just a tooling limit: the gate reads rendered
`innerText` through puppeteer, so if the auditor reads the *same* way, reader and gate
share every blind spot and the gate degrades from an independent check into a
hallucination detector. Reading raw HTML and gating on rendered text is the only
configuration where the check is genuinely independent.

The evidence below says that argument is correct and irrelevant, because arm A cannot read.

## Result 1: arm A is unusable, for a reason the design did not anticipate

**Six sites, zero findings shipped.**

| Site | Findings claimed | Shipped | Gate drops | Runtime |
|---|---|---|---|---|
| apexvolumetrics.com | 0 | 0 | 0 | 139s |
| lisbon.amplify.eu | 1 | 0 | 1 | 174s |
| sambleinnovations.com | 0 | 0 | 0 | 48s |
| propstrata.com | 0 | 0 | 0 | 66s |
| r3p.xyz | 2 | 0 | 2 | 291s |
| jackpotter.com | 1 | 0 | 1 | 140s |

Two independent causes, and both are structural rather than tunable.

### It cannot read a JS-rendered site at all

WebFetch executes no JavaScript. On `sambleinnovations.com` the auditor read **0 of 5
pages** and said so plainly:

> "Pages read: 0 of 5 planned (homepage fetched twice, same empty result). Could not read:
> homepage body and all subpages, because the site renders content via JavaScript after
> load and WebFetch only sees the pre-render HTML shell."

The pipeline reads that site fine. On `apexvolumetrics.com` the homepage and three more
pages came back title-only. That is a third of the test set unreadable.

To its credit the auditor never faked it: apex's run correctly declined to flag the
answer-less FAQ, calling it "classic client-side accordion hydration; this is the absence
trap". The honesty held. There was just nothing to audit.

### WebFetch is not a verbatim reader, and the product is verbatim quotes

This is the disqualifying one, and it was not on the risk list. Claude Code's WebFetch
converts HTML to markdown *and passes it through a summarising model*. Three distinct
corruptions showed up in six runs:

1. **Paraphrase.** The lisbon auditor caught it itself: "Homepage's first fetch
   (paraphrased) rendered 'Avenida Liberdade' as a studio name vs the-studios.html's
   'Avenida' — re-fetched homepage for verbatim text and it actually says 'Avenida' too;
   the discrepancy was an artifact of the summarizing fetch, not the real page."
   An entire finding, manufactured by the reader.
2. **Markdown injection.** r3p's quote came back as
   `LinkedIn & MIT. (2022). "The strength of weak ties..." *Nature*, 608, 351–356.`
   The asterisks are the markdown conversion, not the page. Gate: FAIL.
3. **Title-as-body.** A contradiction cited `REP — Reputation Layer for the AI Internet`
   against `https://r3p.xyz/`. That is the `<title>`, absent from body `innerText`. Gate: FAIL.

A method whose deliverable is character-exact client-facing quotes cannot use a reader
that rewrites them. The gate caught all of it — 4 quote drops, 0 false positives reached a
report — but catching it is the same act as destroying the finding.

**Arm A is closed.** Not "poor results worth another prompt": the reader is wrong for the job.

## Result 2: the render pass fixes reading, and broke something worse

Arm B on `r3p.xyz` shipped a **critical** finding:

> `0.0M+ People using REP` — the "REP IS GROWING" stats all render as zero, contradicting
> the hero's `3.4M+ Users / 30M+ Profiles built / 8.5M+ Achievements earned`.

Verified in a real browser (Chrome, real viewport): the counters animate on scroll, pass
through `1.1M+ / 9M+ / 2.6M+` at ~2s, and settle at **`3.4M+ / 30M+ / 8.5M+ / 24K+`**,
exactly matching the hero. **The finding is a false positive.**

It shipped because arm B read with `read-url.mjs` and the gate checked with
`code-gate.mjs`, and those two run the identical capture routine. The predicted
independence collapse, on the first site tested. The gate did not fail to catch a lie; it
was structurally incapable of disagreeing.

Worse, arm B *lost* both real findings arm A had found on r3p (the Nvidia CTO/CEO factual
error, a grammar run-on). 2 real → 1 false. **A rendering browser made the auditor more
confident and more wrong**, because a rendered read looks authoritative even when the
instrument is lying.

## Result 3: the instrument has been lying to the pipeline all along

The obvious fix was a longer settle time. It does not work, and finding out why is the
most valuable thing in this run.

`read-url.mjs` scrolls **600px every 80ms**. That is faster than an IntersectionObserver
can fire, so on r3p the counters *never start animating*. The reader records a stable
`0.0M+` — stable, so waiting longer detects nothing. "Never animated" and "finished
animating" are indistinguishable downstream.

Measured, not guessed:

| Scroll rate | r3p counters read as |
|---|---|
| 600px / 80ms (`read-url.mjs`, and `code-gate.mjs`) | `0.0M+ / 0M+ / 0.0M+ / 0K+` |
| 400px / 220ms (`render-read.mjs`) | `3.4M+ / 30M+ / 8.5M+ / 24K+` |
| Real Chrome, human scroll | `3.4M+ / 30M+ / 8.5M+ / 24K+` |

**This is a live bug in the shipping pipeline, not just in the experiment.** Every
scroll-triggered element on every site ever audited has been read pre-animation. It is
visible in the existing run records: the r3p judge log spends a rejection on those
counters *on every single run*, and the 30 Jul baseline logged the same rejection
verbatim. The judge has been quietly compensating for a broken reader for weeks. On
r3p that costs a rejection; on a site where the animated value is the finding, it costs
the finding.

`read-url.mjs` and `code-gate.mjs` are deliberately **not** patched on this branch:
changing the shared instrument mid-benchmark invalidates the comparison, and the fix
belongs on its own change with the traps re-run.

## Result 4: arm N, the faithful reproduction

Arms A and B carried a bad assumption: that WebFetch stands in for `web.loadPage`. It
does not, and is close to its opposite. `web.loadPage` returns rendered text and
explicitly no raw HTML; WebFetch returns raw HTML converted to markdown and then passed
through a summarising model. Arm N drops WebFetch entirely (withheld at the tool layer,
not asked for in the prompt): **WebSearch for discovery, a rendering reader for pages,
then the gate.** That is the Notion skill's shape.

| Site | Pipeline 1-pass | Arm N |
|---|---|---|
| apexvolumetrics.com | INCONCLUSIVE · 0 (w0) · 204s | **REPORT · 2 (w7) [critical, medium]** · 217s |
| lisbon.amplify.eu | REPORT · 3 (w4) [M,L,L] · 97s | **REPORT · 3 (w8) [critical, M, L]** · 210s |
| sambleinnovations.com | good-shape · 0 (w0) · 55s | INCONCLUSIVE · 0 · 196s |
| propstrata.com | good-shape · 2 (w2) [L,L] · 82s | INCONCLUSIVE · 0 (see gate note) · 319s |
| r3p.xyz | REPORT · 2 (w3) [M,L] · 131s | REPORT · 1 (w3) [**high**] · 324s |
| jackpotter.com | REPORT · 3 (w5) [M,M,L] · 112s | REPORT · 1 (w5) [**critical**] · 174s |

| Arm | Findings | Weight | REPORTs | Gate drops | Median runtime |
|---|---|---|---|---|---|
| Pipeline | 10 | 14 | 3 | 1 | 112s |
| Arm N | 7 | 23 | 4 | 2 | 217s |

**Arm N ships fewer findings and far more weight.** The severity column is the whole
story: across all six sites the pipeline produced **zero critical and zero high**
findings, all ten were medium or low. Arm N produced **three criticals and one high**.
Measured against the stated goal — "every audit either surfaces at least one finding a
prospect would act on, or says plainly that it couldn't" — the pipeline surfaced none on
any site, and arm N surfaced one on four of six.

Cost: roughly 2x wall clock, and $0 marginal on the subscription engine either way.

### Verified independently (real browser, not either tool's instrument)

- **apexvolumetrics, critical, confirmed.** Homepage: "Your data is encrypted and secure.
  We never share your information". `/privacy`: "Categories \"sold\" or \"shared\" in the
  last 12 months: identifiers and internet activity shared with advertising and analytics
  partners such as Meta and Google for cross-context behavioral advertising." A flat
  contradiction with CCPA exposure. The pipeline shipped a false all-clear on this site.
- **sambleinnovations `/privacy`, confirmed** (arm B, same reader). Client-side redirects
  to `/privacyos` and renders the product page; no privacy policy exists on the site, from
  a vendor selling compliance. Arm B established it against a 404 control probe.
- One rationale error to note: arm N's apex prose says "Meta and X/Twitter"; the policy
  says "Meta and Google". Both quotes are real and the finding stands, but the prose needs
  proofing before it reaches a PDF.

### The gate note, and it is the most important result here

propstrata's INCONCLUSIVE is not the auditor's failure. Arm N found the `/blog` page stuck
at "Loading tags..." with no posts — **verified real in a real browser, and independently
verified in the 30 Jul baseline**. The gate deleted it.

| Gate | Verdict on `"Loading tags..."` |
|---|---|
| `code-gate.mjs` (master, 600px/80ms) | **PASS** |
| `code-gate-stable.mjs` (this branch, 400px/220ms) | **FAIL** |

Both are defensible. The r3p counters need *more* dwell to read truthfully; the propstrata
blog needs *less*, because the evidence is a loading message and loading messages go away.
There is no single capture timing correct for both.

**The structural conclusion: a quote-matching gate cannot arbitrate absence or
loading-state findings.** "This page never renders posts" has no stable string to prove it,
and the strings it does have are timing artefacts. On JS-rendered sites that class is where
the valuable findings live: propstrata `/blog` and samble `/privacy` are both this class and
both are real. The gate is right for the job it was built for (is this quote really on the
page, which is what a client will ctrl-F) and actively harmful outside it, where it silently
deletes true criticals. The 30 Jul baseline already logged the symptom: "Quote gate dropped
2 findings, both verified real."

Scored under master's gate instead, arm N is 8 findings, weight 28, 5 REPORTs.

## Recommendation

1. **Adopt arm N's reading shape**: the auditor picks its own pages via search and reads
   them with a rendering browser. Drop the picker model. It beat the pipeline on severity
   on 4 of 6 sites and produced every critical in the run.
2. **Fix `read-url.mjs`'s scroll rate** on its own change, with the traps re-run. It is a
   live bug affecting every audit shipped to date.
3. **Do not gate absence findings on a quote.** They need a different check: a control
   probe against a known-bad URL, which arm N already performs unprompted, recorded as
   structured evidence rather than a quotable string.
4. Advisor (`--advisor opus`) is confirmed working through the gateway on this machine but
   untested on a real audit. It is the next lever, not a needed one yet.

## Reproducing

```
cd audit
node scripts/websearch-batch.mjs A                      # arm A
WSA_RENDER=1 node scripts/websearch-batch.mjs B         # arm B
WSA_STABLE=1 node scripts/websearch-batch.mjs C         # arm C
node scripts/websearch-compare.mjs goal A B C           # the table
```

Sequential on purpose: the 31 Jul baseline got apexvolumetrics to bot-block us after ~10
runs against one origin in a night, and then read the resulting failure as evidence about
the method.

Advisor (`--advisor opus`, `WSA_ADVISOR=1`) is wired but untested: it is Anthropic-API
only, and `ANTHROPIC_BASE_URL` is set on this machine, so it depends on the gateway
forwarding the request intact.
