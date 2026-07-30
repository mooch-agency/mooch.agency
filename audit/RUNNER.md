# Audit batch runner (moochbot runbook)

The manual-first (R2) runner for the self-serve audit. Moochbot follows this when
Tahi says **"start the run for all approved audits"** (about once a day). No daemon,
no polling. Story 16 on the [v1 audit ticket](https://app.notion.com/p/9890fd90a98841c1a5b223f8e713bb65).

Two human flips gate every report: **run** (New → Approved, by Natalie) and **send**
(Ready for review → Send, by whoever reviewed the PDF). Nothing leaves without both.

## Status flow

```
New ──(Natalie reviews lead)──▶ Approved ──(runner)──▶ Ready for review
   └▶ Rejected                                              │
                                        (human reads PDF)   ▼
                                   Rejected ◀──┐        Send ──(runner)──▶ Sent
                                               └─ back to Approved (regenerate)
```

## Preconditions (env)

Run everything from `audit/`. Required in the environment:

- `NOTION_TOKEN` — moochbot integration (Keystore › Notion). Reads/writes the Leads DB.
- `ANTHROPIC_API_KEY` — the pipeline's picker + judge (Keystore › Anthropic). See "LLM engine".
- `RESEND_API_KEY` — sending the report (Keystore › Resend).
- `CHROME_PATH` — optional; defaults to the macOS Google Chrome path.

`AUDIT_LEADS_DS_ID` defaults to the live data source; override only for a test DB.

### `AUDIT_PIN_PAGES` — skip the picker

Comma-separated paths or full URLs. When set, the pipeline reads exactly those
pages and the picker never runs, so `picker_cost` is 0 and the judge log says the
pages were pinned rather than chosen.

```
AUDIT_PIN_PAGES=/pricing,/refund-policy,/terms node scripts/run-audit.mjs …
```

Use it to re-read a specific set: reproducing a verdict, or checking whether the
judge behaves differently on pages you picked by hand. It is a debugging lever,
not part of the daily flow. Empty is falsy, so the default is normal picking, and
the workflow input defaults to empty: nothing to unset between runs.

**A pin that cannot be honoured exits 4.** If a pinned path is not in the site's
inventory the run stops rather than quietly auditing whatever did match, which
would silently change the evidence an experiment is holding constant. Pinning the
homepage (`/`) is fine: it is always read, and is deliberately absent from the
inventory. `AUDIT_PIN_LENIENT=1` restores best-effort matching for exploratory use.

### `AUDIT_JUDGE_PASSES` — judge N times, ship what recurs

Default 1. Set higher to run the judge N times over the **identical** bundle and
merge by recurrence:

| Seen in | Severity | Outcome |
|---|---|---|
| ≥2 passes | any | ships |
| 1 pass | high/critical | ships anyway |
| 1 pass | low/medium | `judge_log.uncorroborated` only |

```
AUDIT_JUDGE_PASSES=3 node scripts/run-pipeline.mjs https://example.com/ myrun
```

Why: the judge agrees with itself about 13-14% of the time run to run
(`benchmark/2026-07-30-baseline.md`), and on r3p the finding it dropped half the
time was the best one on the site. Recurrence is a measured confidence signal,
unlike asking the judge how sure it is.

Passes run concurrently, so 3 passes cost roughly 1.8x wall clock on the judge
stage, and $0 marginal on the subscription engine. Each shipped finding carries
`passes`, `pass_total` and `confidence`.

### `AUDIT_LLM=subscription` — and what it costs you

$0 marginal, but **no raw judge reasoning**. That path shells out to `claude -p`,
which emits no thinking blocks at any effort or display setting, so
`<tag>.judge-raw.txt` will only ever hold the final output. If you need the
reasoning, run that one site on `AUDIT_LLM=api` and pay for it. This is not a
config problem; do not go looking at `thinking.display` again.

## Daily flow

### 1. Run every Approved lead

```
node scripts/leads.mjs list Approved
```

For each row (`{pageId, url, email, auditId}`):

```
# auditId comes from the row; if blank, mint one (aud_<something>) and it threads through.
node scripts/run-audit.mjs "<url>" "<auditId>" "<email>"
#   -> report/out/<host>_<auditId>.pdf  (+ .html, + <auditId>.record.json)

node scripts/leads.mjs attach "<pageId>" "report/out/<host>_<auditId>.pdf"
node scripts/leads.mjs set "<pageId>" "Ready for review" "<one-line coverage note>"
```

`run-audit.mjs` runs the pipeline (picker → fetch → hard-404 → judge → **code gate**),
then renders the branded report + PDF. Only gate-passed findings appear. If the run
returns thin, the report is the "good shape" variant automatically (story 13).

**Read the PDF on the row before it can go out.** If a finding looks doubtful,
open the **How the audit reached these findings** toggle on the row page. The
runner writes it on every run: what the judge compared across the pages, then per
finding, how it got there, what innocent explanation it tested, what ruled that
out and why it picked that severity, then what it considered and deliberately did
not flag. That last list is how you spot a judge gone too keen or too shy.
Anything the quote gate dropped is listed too, marked as absent from the report.

The toggle replaces itself on a re-run and touches nothing else on the page, so
your own notes are safe to type alongside it. Contradiction findings also carry
both conflicting quotes (`quote`/`quote2`), so the report evidences both sides.
The same summary is in `judge_log` on the row's `.record.json`. The judge's
**verbatim reasoning** goes on the row too, in a second toggle, **Judge's full
reasoning (raw)**: thinking then output, chunked because Notion caps a block at
2000 chars. It is written from `scripts/runs/<tag>.judge-raw.txt` during the run,
because on a CI runner that file is destroyed when the job ends. The same files
are also uploaded as the `judge-raw` artifact on every Actions run, including
failed ones, which is the only copy when a run aborts before it has a row to
write to.

Running a lead by hand rather than via the batch? Add the log step:

```
node scripts/leads.mjs log "<pageId>" "report/out/<auditId>.record.json"
``` Good → flip Status to **Send**.
Needs changes → comment on the row and flip back to **Approved** (next run regenerates).
Unusable site / failed run → reply personally and set **Rejected** (never a half report).

### 2. Send every Send lead

```
node scripts/leads.mjs list Send
```

For each row, dry-run first, eyeball, then send for real:

```
node scripts/send-report.mjs "report/out/<auditId>.record.json" "report/out/<host>_<auditId>.pdf" --dry-run
node scripts/send-report.mjs "report/out/<auditId>.record.json" "report/out/<host>_<auditId>.pdf"
node scripts/leads.mjs set "<pageId>" "Sent"
```

The email is the lean HTML teaser + the PDF attachment, from `hey@mooch.agency`,
**cc hey@** so we keep a copy. Resend confirms the address is real (last line of the
junk defence).

## LLM engine (R2 vs R3)

Two engines, switched by `AUDIT_LLM`:

- **`subscription`** — `claude -p` on Tahi's subscription, $0 marginal. The R2
  default for the daily runner: `AUDIT_LLM=subscription node scripts/run-audit.mjs …`.
  Requires the `claude` CLI logged in on this Mac. Smoke-tested 20 Jul: tability
  trap passes, cost 0.
- **`api`** (code default) — the SDK pipeline via `ANTHROPIC_API_KEY`,
  ~$0.11–0.22/audit. Use when running anywhere the CLI isn't logged in (R3's
  server runner).

If a run exits with `UNREADABLE_SITE`, that lead is a story-13 personal-reply
case: don't send anything, reply to them yourself and set **Rejected**.

## Tests

Run both after any change to the reader, picker, judge, gate or fallback.

```
pnpm --dir audit test                                   # unit tests, no network, seconds
AUDIT_LLM=subscription node scripts/regression-traps.mjs # live traps, ~3 min, $0 marginal
```

Unit tests cover the thin-text / bot-block fallback (`page-fallback.mjs`): the
retry, the next-priority swap, and the coverage note for a page with no readable
substitute. Plus the discovery host rules (`discovery.mjs`): a site is its
registrable host, and the inventory is built against where the homepage LANDED,
not the URL the lead submitted. A site that redirects apex to www used to lose
every link on the page and get audited on its homepage alone. The traps are the false-positive tripwires: tability's hidden per-user
price must never surface, stedmansplumbing's "including Prather…" must never be
flagged as a coverage contradiction, and the hard-404 predicate must catch a 404
without flagging a 200.

## R3 (automation) — two toggles, no rebuild

1. **Trigger:** replace "moochbot runs step 1 daily" with run-on-submit (the endpoint
   or a webhook enqueues). Turnstile + rate caps replace Natalie's eyeball on New.
2. **Send-gate:** replace the human Send flip with auto-send once the code gate passes
   and the report clears the thin-report floor.

The scripts (`leads`, `run-audit`, `send-report`) do not change.
