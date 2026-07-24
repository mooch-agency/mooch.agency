# Self-serve content audit — v1 prototype scripts

Validated prototype for the mooch.agency self-serve audit (Sprint 9 build). Method and
evidence live in the Notion exploration ticket and its case study page; this folder holds
the three scripts that survived the exploration.

## Runtime shape (measured 18 Jul 2026)

Picker (Sonnet 4.6, chooses up to 4 key pages from the homepage's text + link inventory)
→ parallel puppeteer `innerText` fetch (home + 4) → programmatic hard-404 check on the
audited pages' internal links → ONE Opus 4.8 judge call over the bundle → code gate.
~$0.11–0.22 and 55–101s per audit on the test set, 0 gate failures.

## Scripts

- `scripts/run-pipeline.mjs` — the full pipeline end to end. `node run-pipeline.mjs <site_url> <run_id> [picker_model]`.
- `scripts/read-url.mjs` — the reader: one URL → rendered visible `innerText` (visibility-aware, UA-masked headless Chrome). The FP-safety of the whole product rides on this instrument.
- `scripts/code-gate.mjs` — the per-run eval gate: every finding's verbatim quote must exist in the cited page's rendered text (curly-quote/dash/whitespace normalised).

## Requirements

- Node 20+, `puppeteer-core`, `@anthropic-ai/sdk`, Google Chrome at the default macOS path (parameterise for the Railway container).
- `ANTHROPIC_API_KEY` in the environment. Never commit keys: this repo is public.

## Regression traps (run against any method change)

- tability.io hidden pricing calculator must NOT appear in findings.
- publishinghousebnb.com footer 404s MUST appear (when link checking is in scope).
- brplumbing "including Bexhill and Hastings" must NOT be flagged as a contradiction.
