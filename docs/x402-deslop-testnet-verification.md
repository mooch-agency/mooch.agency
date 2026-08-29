# Testnet verification: /api/deslop over x402

Full protocol round trip tested live against production, 2026-08-29. Not a
simulation: real HTTP calls to mooch.agency, real signed payment, real
on-chain settlement, on base-sepolia.

## Setup

- Receiving wallet (`X402_PAY_TO`, set in Vercel production): a fresh EVM
  keypair generated locally with viem, `0xA2fFC5ae0EC71423e769ff9af083950D5370d7F9`.
  Testnet only — do not reuse for mainnet. Key lives in `.env.wallet.local`
  (gitignored), not in a CDP Server Wallet, since that's the manual signup
  step in [x402-deslop-mainnet.md](./x402-deslop-mainnet.md).
- Payer (burner test wallet): `0x357b7a7B33e5F23Ef0751648a6c0daF3999cD23C`,
  same generation method, key in `.env.payer.local` (gitignored). Funded with
  20 testnet USDC from faucet.circle.com (base-sepolia). No ETH needed — the
  `exact` scheme uses EIP-3009 `transferWithAuthorization`, an off-chain
  signed message; the facilitator pays gas on settlement, not the payer.
- Payment header built with the `x402` npm package's own client helper
  (`createPaymentHeader` from `x402/client`), not hand-rolled, so this test
  exercises the same code path a real integrating agent would use.

## Result

1. `POST /api/deslop` with no `X-PAYMENT` header → `402`, correct payment
   requirements returned (`scheme: exact`, `network: base-sepolia`,
   `maxAmountRequired: 100000` = $0.10 USDC, `payTo` matching the configured
   wallet, USDC asset address for base-sepolia).
2. Signed `X-PAYMENT` header attached, same request retried → `200 OK`.
3. Response body: real Claude Sonnet 5 output, not a stub —
   `{"cleaned": "We built a platform we're proud of.", "changelog": "...", "price": "$0.10 USDC on base-sepolia"}`.
4. `X-PAYMENT-RESPONSE` header decoded to
   `{"success":true,"transaction":"0xb48de9522294ff450970455324c36736cd92dcf83cc9cbe43ac88d6d7b5800c24","network":"base-sepolia","payer":"0x357b7a7B33e5F23Ef0751648a6c0daF3999cD23C"}`
   — settlement confirmed on-chain, not just claimed by the response.

Confirms the full loop works end to end on testnet: 402 challenge, payment
verification, paid model call, on-chain settlement, correct response. The
remaining gap to a real launch is entirely the manual mainnet setup in
[x402-deslop-mainnet.md](./x402-deslop-mainnet.md) (CDP account, mainnet
facilitator, real receiving wallet) — no code path was left unexercised by
this test.
