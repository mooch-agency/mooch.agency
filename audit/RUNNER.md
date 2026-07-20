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

**Read the PDF on the row before it can go out.** Good → flip Status to **Send**.
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

## R3 (automation) — two toggles, no rebuild

1. **Trigger:** replace "moochbot runs step 1 daily" with run-on-submit (the endpoint
   or a webhook enqueues). Turnstile + rate caps replace Natalie's eyeball on New.
2. **Send-gate:** replace the human Send flip with auto-send once the code gate passes
   and the report clears the thin-report floor.

The scripts (`leads`, `run-audit`, `send-report`) do not change.
