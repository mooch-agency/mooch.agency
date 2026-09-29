# Credit Cards discovery tiers: test read, 29 Sep 2026

One capped read per tier over 22 to 29 Sep 2026 (start_time 2026-09-22T11:00Z),
300 posts in total, scored offline with the repo's own helpers
(`creditcards-discover.mjs`, `creditcards-search.mjs`) against
`data/creditcards.json` on master at 56be86c (Debits NFT approved). The app
bearer token can't reach the dev box, so the posts came from the X full-archive
search endpoint through the owner's connected X account. It supports the same
operators, and the same queries, fields and caps were used. Nothing was written
to the list.

## Results per tier

"Real new" counts projects that aren't in the list as approved, pending or
rejected. "Noise" counts new candidate URLs that aren't Credits projects. Posts
per day is the page size divided by the time span the page covered. Every tier
filled its cap, so these are rates, not totals.

| Tier | Posts read | Posts/day | Candidates (new URLs) | Real new | Noise | Notes |
|---|---|---|---|---|---|---|
| Baseline (current query) | 50 | 11 | 27 (5) | 3 | 0 | Credit Dogs, Punks x Credits, a Chrome extension (no link yet). One URL was a Debits mint page. |
| A anchor | 100 | 183 | 10 (8) | 4 | 1 | Punks x Credits, Witness, Hood Credits, Credits Rarity Rank extension. About 45 of the 100 posts were one Punks x Credits free-mint WL campaign. The cap was hit 13 hours back. |
| B vocab | 50 | 22 | 14 (12) | 0 | 1 | 25 of 50 posts were Credit Union "I joined..." posts (a listed host). |
| C derivatives/hosts | 50 | 144 | 32 (31) | 0 | 26 | Bare `url:credits` / `url:debits` matched 35 of 50 posts: carbon credits, post-credits scenes, API credits, bank news. The other 15 were Debits (Wubbushi) mint shares. |
| R replies to @jesusdoteth | 25 | 36 | 1 (1) | 0 | 0 | Mostly "gm". jamesrichardfry's Debits reply resolved via bio to the listed Debits NFT. |
| X replies to @jackbutcher (experimental) | 25 | 12 | 5 (4) | 0 | 4 | Fiverr spam, unrelated collections, "free mint" reply spam. |

The Debits post by jamesrichardfry (2104677909214716203) was not read by any
tier. The baseline covered its time but doesn't match it, because it's image-only
and `has:links` drops it. The anchor would match it, but its 100-post cap ran out
about an hour short of it. On the live schedule (since-id windows, 2 x 100 per day
against ~183 per day) the anchor tier reads it.

The Credits Rarity Rank extension (@CEST_nft) only surfaced after the helper fix
below: its GitHub link sits past 280 characters, in `note_tweet.entities`.

## Real new finds

- @CreditedDogs, Credit Dogs: https://opensea.io/collection/credit-dogs. A 10k derivative, free mint for Credits and Credited Punks holders. https://x.com/CreditedDogs/status/2103753935404347757
- @Internetanount (A.C.J.), Punks x Credits: https://punk.credit and https://opensea.io/collection/punks-x-credits. 4,444 Punks rebuilt from Credits, free mint with a WL form, heavily shilled. https://x.com/Abdullah4660/status/2104854045382840391
- @catradarusman, Witness: https://witness.catra.fyi. A sign-and-print mint that closes when Statements open. https://x.com/catradarusman/status/2104768762813833648
- @CEST_nft, Credits Rarity Rank for OpenSea: https://github.com/0XCEST/credits-opensea-rank. An open-source Chrome extension with ranks on the OpenSea grid. https://x.com/CEST_nft/status/2104740927499637225
- @WhyCaptainY, a Chrome extension with score and rank on OpenSea. It's waiting on the Chrome store, so there's no project link yet (the bio is linkin.bio). https://x.com/WhyCaptainY/status/2103306179426541956
- @HoodCredits, Hood Credits: https://opensea.io/collection/hood-credits. A 10k Credits copy on Robinhood Chain, free mint. Low value, and likely a reject. https://x.com/HoodCredits/status/2104889300068495411

## Tuning in this change

- C: dropped bare `url:credits` and `url:debits`. They produced 26 of 26 noise candidates and no finds. The phrases, `(debits credits)` and the tool-host clause stay.
- B: excluded `url:"creditunion.fun"`. Its join posts were half the tier, and all were a known host.
- Helpers: `entityLinks` also reads `note_tweet.entities.urls`, and the live fetch asks for `note_tweet`. `normaliseUrl` maps http to https, so long-post links like `http://mylesdaughtry.com` match the listed https entries instead of resurfacing as new.
- A, R: unchanged. The anchor tier did the real work, and R is the submission channel.
- X: stays experimental. It had 0 finds in 25 posts.

## Measured monthly cost (about $0.005 per post)

Schedule as configured: two runs a day. "every" tiers run on both, "morning"
tiers once. Reads per day are min(measured rate, cap).

| Tier | Rate/day | Cap/day | Reads/month | $/month |
|---|---|---|---|---|
| A anchor | 183 | 200 (50 x 2 pages x 2 runs) | 5,490 | 27.45 |
| B vocab (tuned, ~half the rate) | ~11 | 25 | 330 | 1.65 |
| C derivatives (tuned, ~30% of the rate, ~43/day) | ~43 | 25 | 750 | 3.75 |
| R replies | 36 | 50 | 1,080 | 5.40 |
| **Tiers A+B+C+R** | | | **7,650** | **~38** |
| X jack-replies, if enabled | 12 | 25 | 360 | 1.80 |
| Current single query, for comparison | 11 | | 330 | 1.65 |

This was a hot week: Statement assembly opens 1 Oct, and one shill campaign made up
nearly half the anchor tier. So the anchor number is an upper-end figure. X bills
a post once per 24 hours, so overlap between runs costs nothing extra (the tiers
already exclude each other). Holding the anchor to one page per run would cap it
at 100/day, about $15/month, but it would drop posts in bursts like the one that
hid the Debits post in this read.
