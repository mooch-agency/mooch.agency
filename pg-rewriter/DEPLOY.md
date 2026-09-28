# Deploy: Write Like Paul Graham

The tool lives in this repo: `paulgraham.html` (the page), `api/rewrite.js` (the
streaming function) and `api/pg-system.md` (the system prompt, generated from
`pg-rewriter/voice/`).

## How it deploys

The repo deploys as the `mooch.agency` Vercel project from `master`. Merging to
`master` ships `/api/rewrite` and `/paulgraham`.

The tool lives at `mooch.agency/paulgraham`, a path, because its code lives in
the agency repo (see "Paths and subdomains" in the root `CLAUDE.md`). It used to
be served at `paulgraham.mooch.agency`; that domain stays on the Vercel project
only so the redirects in `vercel.json` can send old links to the path.

## Environment variables

Set these on the Vercel project (Production):

- `OPENAI_API_KEY`: required. The rewriter's OpenAI key.
- `PROVIDER`: `openai` (default) or `claude`.
- `ANTHROPIC_API_KEY`: only if `PROVIDER=claude`.
- `OPENAI_MODEL` / `CLAUDE_MODEL`: optional overrides (defaults `gpt-5.5` and `claude-sonnet-4-6`).
- `REWRITER_DISABLED`: set to `1` to pause the tool without redeploying.

## Model

gpt-5.5 is the default, chosen on a bake-off against gpt-5-mini, Sonnet 4.6, and
Opus 4.8: it leads on PG-fit and reads cleanest (see `voice/test/RESULTS.md`).
Claude is a one-variable fallback (`PROVIDER=claude`).

## Verify

- `curl -N -X POST https://mooch.agency/api/rewrite -H 'content-type: application/json' -d '{"text":"It could be argued that..."}'` streams `data:` tokens.
- Load the page, paste, hit Rewrite, watch the before/after Voice Score, copy.

## Cost guards

A server word cap, a conservative `max_tokens`, a best-effort per-instance rate
limit, an origin check, and the `REWRITER_DISABLED` kill switch. Set a monthly
spend ceiling in the provider console too.

## Parked for v2

A live "N paragraphs rewritten" counter and a durable rate limit, both of which
need a store (Cloudflare KV or similar).
