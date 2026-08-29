# Going to mainnet: wallet + facilitator decision

Decided (per Tahi, "my vote is Coinbase"): **Coinbase CDP for both the receiving
wallet and the facilitator.** Reasoning below, plus exact manual steps, since
account creation needs Tahi's own identity and isn't something to automate.

## Why CDP for both

- One provider, one dashboard, one set of API keys, instead of juggling a
  separate wallet tool and a separate facilitator.
- CDP's facilitator is free for the first 1,000 settled transactions a month,
  then $0.001/tx. Only successful settle calls are billable; verify calls and
  failed settles are free. At the ambition level of this experiment (an
  agency's paid-per-call side project), this is effectively free.
- CDP's non-custodial "Server Wallet" product means Mooch never holds a raw
  private key. Coinbase's TEE holds the key; the server authenticates with an
  API key + a separate wallet secret. This removes "someone's laptop has the
  only copy of the key that controls the money" as a failure mode.
- No business verification / KYC needed for this path. That's only required
  for Coinbase's custodial products (Prime, linked business accounts). A CDP
  Portal signup plus an API key is self-serve and near-instant.

## What this does NOT need

No incorporation documents, no beneficial-owner forms, no waiting period.
Confirmed against CDP's own docs (docs.cdp.coinbase.com/x402/support/faq and
/get-started/initial-setup): the non-custodial x402 facilitator + Server
Wallet path is explicitly exempt from the KYC requirement that applies to
Coinbase's custodial account products.

## [MANUAL] Exact steps for Tahi

1. Sign up at portal.cdp.coinbase.com (a first project is created
   automatically).
2. API Keys → Secret API Keys tab → Create API key. Save the Key ID and Key
   Secret shown in the modal — they are not retrievable again. Record them in
   the Mooch Keystore as `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`.
3. Create a Wallet Secret (same dashboard flow, adjacent to API keys). Record
   as `CDP_WALLET_SECRET`.
4. Either create a Server Wallet via the CDP SDK (`cdp.evm.createAccount()`,
   or the named variant `getOrCreateAccount({ name: "mooch-deslop" })` so the
   same address persists across redeploys) and use its address as
   `X402_PAY_TO` — or, if Tahi already has a Base wallet he wants to receive
   into directly, just use that address and skip Server Wallet creation
   entirely; CDP's facilitator doesn't require the receiving address to be
   one of its own wallets.
5. Set in Vercel production env: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
   `CDP_WALLET_SECRET` (only if using a CDP Server Wallet), `X402_PAY_TO`,
   `X402_NETWORK=base`.
6. api/deslop.js currently points `X402_FACILITATOR_URL` at the keyless
   `x402.org/facilitator` testnet default. Switching to CDP's mainnet
   facilitator needs a small code change (CDP's current pattern uses
   `@coinbase/cdp-sdk`'s `createX402Server` rather than a bare facilitator
   URL + API key pair) — a short follow-up PR once the CDP account exists,
   not a config-only flip. Flagged as a separate ticket rather than guessed
   at blind.

## Price sanity check: $0.10 vs actual model cost

Claude Sonnet 5 pricing (docs.claude.com/en/docs/about-claude/pricing,
confirmed permanent as of 10 Aug 2026): $2/MTok input, $10/MTok output.

Worst case per call: ~3,350 input tokens (the ~750-token system prompt plus
the 2,000-word input cap) and the full 4,000-token `max_tokens` output cap
→ ≈ $0.047. Against the $0.10 price, that's roughly 53% margin even at the
absolute ceiling. Most real drafts won't hit the output cap, so typical
margin is wider. $0.10 holds; no change needed. CDP's facilitator fee
($0.001/tx after the first 1,000/month) doesn't meaningfully change this.

## Discovery, once mainnet is live

Set `discoverable: true` (already the case in the current payment
requirements) and settle one real payment through CDP's facilitator — that
alone gets the endpoint auto-indexed on x402bazaar.org / CDP's Bazaar. No
separate submission. Two other directories need a manual listing regardless:
gold-402 (GitHub PR to Haustorium12/gold-402, one line in `directory/apis.md`
plus an `Example:` line since /api/deslop needs a POST body) and
x402-list.com (its own submission form at x402-list.com/submit).

Sources: docs.cdp.coinbase.com/x402/quickstart-for-sellers,
docs.cdp.coinbase.com/x402/core-concepts/facilitator,
docs.cdp.coinbase.com/x402/support/faq,
docs.cdp.coinbase.com/wallets/quickstart/api-key-auth,
docs.cdp.coinbase.com/x402/bazaar, docs.cdp.coinbase.com/x402/seller/get-discovered,
github.com/Haustorium12/gold-402/blob/main/CONTRIBUTING.md, x402-list.com/submit.
