# PG voice profile build

The voice profile that powers Write Like Paul Graham (mooch.agency/paulgraham).

## Files

- `paulgraham.md`: the voice profile. The system-prompt foundation.
- `build_stats.py`: deterministic scraper + statistical profiler. Committed.
- `score.py`: scores any prose against PG's own 10-90 percentile range per
  metric (validation, testing other rewrites, the in-app before/after readout).
  100 = every dial inside PG's range. `python3 score.py a.txt b.txt`.
- `stats.json`: script output. Holds the sample targets, PG's per-metric ranges,
  per-essay numbers, and the full-corpus headline (208 essays, 490,813 words).
  Committed.
- `test/`: validation fixtures and `RESULTS.md` (lightweight capture-vs-flattery
  pass, bias-controlled with subagents).
- `corpus/*.txt`: scraped clean essay text. Gitignored (PG's copyright);
  regenerate with the script.

## Method

1. Scrape a 20-essay sample from paulgraham.com (`requests` + `BeautifulSoup`,
   no headless browser: the site is static HTML). Extract the largest
   `<font size="2" face="verdana">` block. Strip `<blockquote>`, the leading
   date and site banner, the trailing footnote section, and the "Thanks to"
   line. Per-essay word-count sanity check so a parse failure can't feed junk
   into the stats.
2. Count the statistical layer with the script. A script counts exactly; a
   model guesses. These numbers are what stop pastiche.
3. Read the same corpus for the interpretive layers (rhetorical moves,
   anti-patterns).
4. Assemble into `paulgraham.md`, stats pre-filled from `stats.json`.

## Rebuild

```
pip install requests beautifulsoup4
python3 build_stats.py
```

Edit the `SAMPLE` / `HOLDOUT` lists in the script to change the corpus, then
re-run and update the numbers in `paulgraham.md` from `stats.json`. Never hand-
edit the numbers.

## Scope note

`paulgraham.md` describes *how PG writes* (reusable). The rewrite instruction
that applies this voice to someone else's text under the meaning-fidelity rule
(preserve the core claim, no invented facts, never reverse their position) is a
separate, tool-specific file, `rewrite.md`. Two files; don't conflate.

## Validation

See `test/RESULTS.md`. The 4 holdout essays (gap, gba, copy, want, never in the
profile stats) are the capture-vs-flattery set: bloat their core claims, rewrite
through the tool, score against PG's range, blind-judge against the real essays.
Headline findings: the develop-tuned rewrite lands ~90 PG-fit; gpt-5.5 beats
gpt-5-mini, Sonnet 4.6 and Opus 4.8; and an independent judge can still tell any
LLM rewrite from genuine PG, so that test reads as an AI-text detector, not a
PG-ness gate.
