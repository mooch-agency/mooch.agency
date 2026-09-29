# Credit Cards search test and ACREDITED perks spike, 29 Sep 2026

The permanent record of two paid X reads made on 29 Sep 2026: a test of the
tiered discovery search for /creditcards (this branch, PR #71), and ACREDITED,
a research spike on perks offered to Credits holders. Search terms come from
[docs/credits-glossary.md](credits-glossary.md).

## Method

- **Window:** 7 days, from 2026-09-22T11:00Z to the morning of 29 Sep, the
  same span recent search covers. This was Credits' launch week.
- **Fetch path:** the app bearer token (`X_BEARER_TOKEN`, an org secret) can't
  reach the dev box, so every post came through the owner's X account via the
  user's X connector, using full-archive search. It supports the same
  operators, and the same queries, fields and caps were used. Access was
  read-only.
- **Volume and cost:** 594 posts in total. 300 were for the search test (one
  capped read per tier) and 294 were for ACREDITED (two runs, against a 400
  cap). X credits for the whole session came to **$2.40**: $0.93 for ACREDITED
  and the rest for the search test. $0.81 was left. X bills a post once per 24
  hours, so re-reads were free.
- **Scoring:** search test posts were scored offline with the repo's own
  helpers (`creditcards-discover.mjs`, `creditcards-search.mjs`) against
  `data/creditcards.json` on master at 56be86c (Debits NFT approved). ACREDITED
  posts were classified by claude-opus-5-5 from plans written by
  claude-fable-5, with the glossary in the classifier context. Nothing was
  written to the list.

## Search test: results per tier

"Real new" counts projects that aren't in the list as approved, pending or
rejected, judged by hand. "Noise" counts new candidate URLs that aren't Credits
projects. Posts per day is the page size divided by the time span the page
covered. Every tier filled its cap, so these are rates, not totals. The
linkless and candidate columns are from the run with the helper fix below.

| Tier | Posts read | Posts/day | Linkless | Candidates (new URLs) | Real new | Noise | Notes |
|---|---|---|---|---|---|---|---|
| Baseline (current query) | 50 | 11 | 18 | 30 (8) | 3 | 0 | Credit Dogs, Punks x Credits, a Chrome extension (no link yet). One URL was a Debits mint page. |
| A anchor | 100 | 183 | 51 | 17 (15) | 4 | 1 | Punks x Credits, Witness, Hood Credits, Credits Rarity Rank extension. About 45 of the 100 posts were one Punks x Credits free mint WL campaign. The cap was hit 13 hours back. |
| B vocab | 50 | 22 | 23 | 15 (13) | 0 | 1 | 25 of 50 posts were Credit Union "I joined..." posts (a listed host). |
| C derivatives/hosts | 50 | 144 | 11 | 32 (31) | 0 | 26 | Bare `url:credits` / `url:debits` matched 35 of 50 posts: carbon credits, post-credits scenes, API credits, bank news. The other 15 were Debits (Wubbushi) mint shares. |
| R replies to @jesusdoteth | 25 | 36 | 25 | 1 (1) | 0 | 0 | Mostly "gm". jamesrichardfry's Debits reply resolved via bio to the listed Debits NFT. |
| X replies to @jackbutcher (experimental) | 25 | 12 | 17 | 5 (4) | 0 | 4 | Fiverr spam, unrelated collections, "free mint" reply spam. |

The anchor tier did the real work: 4 of the 6 real finds, and the only tier
with finds the baseline didn't have. B, C and X found nothing real in 125
posts between them.

## Real new finds

- @CreditedDogs, Credit Dogs: https://opensea.io/collection/credit-dogs. A 10k derivative, free mint for Credits and Credited Punks holders. https://x.com/CreditedDogs/status/2103753935404347757
- @Internetanount (A.C.J.), Punks x Credits: https://punk.credit and https://opensea.io/collection/punks-x-credits. 4,444 Punks rebuilt from Credits, free mint with a WL form, heavily shilled. https://x.com/Abdullah4660/status/2104854045382840391
- @catradarusman, Witness: https://witness.catra.fyi. A sign and print mint that closes when Statements open. https://x.com/catradarusman/status/2104768762813833648
- @CEST_nft, Credits Rarity Rank for OpenSea: https://github.com/0XCEST/credits-opensea-rank. An open source Chrome extension with ranks on the OpenSea grid. https://x.com/CEST_nft/status/2104740927499637225
- @WhyCaptainY, a Chrome extension with score and rank on OpenSea. It's waiting on the Chrome store, so there's no project link yet (the bio is linkin.bio). https://x.com/WhyCaptainY/status/2103306179426541956
- @HoodCredits, Hood Credits: https://opensea.io/collection/hood-credits. A 10k Credits copy on Robinhood Chain, free mint. Low value, and likely a reject. https://x.com/HoodCredits/status/2104889300068495411

## Why no tier read the Debits post

The Debits announcement by jamesrichardfry
(https://x.com/jamesrichardfry/status/2104677909214716203, 28 Sep 21:01 UTC)
is the one known project from the week that no tier read. It was approved by
hand in PR #70.

- **Baseline:** it covered the post's time but doesn't match it. The post is
  image only, and `has:links` drops it.
- **Anchor:** it matches (the query matches the full text server side), but
  its 100-post cap ran out about an hour short of the post, because the Punks
  x Credits campaign filled the page.
- **On the live schedule** (since-id windows, 2 x 100 a day against about 183
  a day) the anchor tier would read it.
- **Reading it isn't enough on its own.** The post's only link is its own
  photo, and its @jackbutcher mention sits past 280 characters, in
  `note_tweet`. An offline replay through the current `discover()`
  (`search-test/replay-debits.mjs`) added 0 candidates. The tiered config's
  bio fallback does qualify it (`wantsBioFallback()` is true: "goes live" plus
  "burn 80" and "permissionless derivative"), so it would borrow the author's
  profile link, permissionlessderivatives.com, the Debits NFT's home. That
  fallback isn't wired in yet, so wiring it in is part of enabling the tiers.

The Credits Rarity Rank extension (@CEST_nft) shows the same long-post problem
from the other side: its GitHub link sits past 280 characters, in
`note_tweet.entities`, and it only surfaced after the helper fix below.

## Tuning made on this branch

- **C:** dropped bare `url:credits` and `url:debits`. They produced 26 of 26
  noise candidates and no finds. The phrases, `(debits credits)` and the tool
  host clause stay.
- **B:** excluded `url:"creditunion.fun"`. Its join posts were half the tier,
  and all were a known host.
- **Helpers:** `entityLinks` also reads `note_tweet.entities.urls`, and the
  live fetch asks for `note_tweet`. `normaliseUrl` maps http to https, so long
  post links like `http://mylesdaughtry.com` match the listed https entries
  instead of resurfacing as new.
- **A, R:** unchanged. The anchor tier did the real work, and R is the
  submission channel.
- **X:** left in the config as experimental and off. See the recommendation.

## Cost estimates (about $0.005 a post)

Schedule as configured: two runs a day. "every" tiers run on both, "morning"
tiers once. Reads per day are min(measured rate, cap).

| Tier | Rate/day | Cap/day | Reads/month | $/month |
|---|---|---|---|---|
| A anchor | 183 | 200 (50 x 2 pages x 2 runs) | 5,490 | 27.45 |
| B vocab (tuned, about half the rate) | ~11 | 25 | 330 | 1.65 |
| C derivatives (tuned, about 30% of the rate, ~43/day) | ~43 | 25 | 750 | 3.75 |
| R replies | 36 | 50 | 1,080 | 5.40 |
| **Tiers A+B+C+R** | | | **7,650** | **~38** |
| X jack-replies, if enabled | 12 | 25 | 360 | 1.80 |
| Current single query, for comparison | 11 | | 330 | 1.65 |

This was a hot week: Statement assembly opens 1 Oct, and one shill campaign
made up nearly half the anchor tier. So the anchor figure is an upper-end
number. Overlap between runs costs nothing extra (the tiers already exclude
each other). Holding the anchor to one page per run would cap it at 100 a day,
about $15 a month, and bring A+B+C+R to about $26, but it would drop posts in
bursts like the one that hid the Debits post.

## Recommendation

1. **Enable A** on the configured schedule (2 pages of 50, both runs). It found
   4 of the 6 real projects and would have read the Debits post live. Wire in
   the bio fallback at the same time, or image-only announcements still slip
   through.
2. **Run B and C at lower caps:** 25 posts, once a morning, as configured (half
   the 50 of this read). Neither found anything real this week, so they are
   cheap insurance, not a source. If they still have no finds after two weeks,
   cut them further.
3. **Drop X.** 0 finds and 4 noise in 25 posts. Remove the experimental tier
   rather than enabling it.
4. **Keep R** as is. It's the submission channel, whatever its yield.

That comes to about $38 a month in a week like this one (dropping X saves the
$1.80 it would add), and less once launch
activity fades.

## ACREDITED perks spike

The question: what do builders offer Credits holders (airdrops, allowlists,
free mints, discounts, early access, gated tools), and is there enough of it
for a perks board? 10 queries over two runs, over the same 7 days.

### Per-run results

| Run | Queries | Posts read (paid) | Posts classified | Perk / ecosystem, not perk / other collection's perk / noise | Perk posts | Unique offers (after dedupe) |
|---|---|---|---|---|---|---|
| 1 | 5 | 165 | 114 | 21 / 58 / 5 / 30 | 21 | 9 |
| 2 | 5 | 129 | 43 | 9 / 22 / 4 / 8 | 9 | 3 (0 new) |
| **Total** | 10 | 294 of 400 cap | 157 | 30 / 80 / 9 / 38 | 30 | **9** (6 listed, 3 borderline, plus 2 borderline leads) |

Run 2 found nothing new: its 9 perk posts restated Debits, Credit Union and
RECEIPTS. Two runs look close to saturating the week's supply on X. The best
queries were the holder offer query (13 perk posts from 53 reads) and the
gated tool query (7 from 17). The anchor offer query was the largest and
returned nothing (0 from 65).

### Perks by type (unique offers)

| Type | Listed | Borderline |
|---|---|---|
| Airdrop | 0 | 0 |
| Allowlist | 3 (Credit Cards by @Jehoseph, Otherides, Credited Punks) | 0 |
| Discount | 0 | 1 (@Jehoseph, conditional) |
| Early access | 0 (Debits' 24-hour holder-only window comes closest) | 0 |
| Free mint | 3 (Debits, The Creditors, CREDIT DOGS) | 3 (RECEIPTS, bloo, Proof of Pixels) |
| Gated tool | 0 | 0 |
| Other | 0 | 1 (Credit Union, a pooling tool) |

All 6 listed perks come from new derivatives or small Credits builders. None
comes from an established collection. Supply was about 6 real perks in the
week, in two bursts: the 48 hours after launch (23 and 24 Sep) and the run-up
to Statements (28 Sep). It's a launch-week figure and can't be extrapolated.

### The airdrop verdict

There were **no real airdrops** to Credits holders. The posts that said
"airdrop" were:

- memecoins raffling Credits to their own coin holders ($CREDITS, $CSTR,
  $JACKOFF, timeflux);
- proposals, such as a suggestion that Credonauts airdrop to the top 40 holders;
- speculation ("what if Elon airdrops credits holders");
- Credits being delivered to their own minters.

The flow mostly runs the other way: 9 posts offered Credits, or Credits
allowlist spots, as the prize for another community's holders. Right now
Credits is more often the prize than the key. And no established collection
offered Credits holders anything, so the worry that perks are reserved for
collections like Punks doesn't hold here: the gap is filled by days-old
derivatives offering free or near-free mints.

### Quality

Low to mixed. In `perks.json`, 4 of the 6 listed perks carry scam flags
(Debits: connect wallet and sign to claim, probably benign; Otherides: thin
author; The Creditors: 49-day-old account; CREDIT DOGS: 5-day-old account and
urgency). The report's summary counts 3, leaving out The Creditors. Several
claim links were unresolved t.co links, and the details of the best offer
(Debits) conflict across posts.

### Recommendation: a Perks filter on Credit Cards

Too thin for a standalone board or a daily feed, and enough for a section of
/creditcards: a **Perks** pill beside the category pills, listing every perk
found, with ended ones kept and muted to show what holders could pick up by
coming back. Listing gates:

- the issuer's own post states the Credits gate (a promoter's echo isn't
  enough);
- a resolved link;
- no scam flags;
- never list coin-holder raffles, social-only (follow and repost) routes,
  "Credits as the prize" offers for other collections, or Jack's own burn-80
  Statement mechanic.

That filter is built in **PR #72** (`creditcards-perks`). Re-read against
the gates on 29 Sep, 2 of the 11 offers pass:

- **Credit Cards by @Jehoseph:** an allowlist for the top 2,000 Credits
  holders plus KYC holders, closing by 1 Oct. The post's only link is
  opensea.io/collection/creditcards, which OpenSea names "Credit Cards". That
  replaces the spike's inferred name.
- **Credited Punks by @wutaner:** a holder mint, now sold out (all 10,000
  minted, per oncave.io).

The other 4 listed offers have scam flags. Credit Union is a tool, not a perk.
The discount is only conditional. RECEIPTS has 4 scam flags, and bloo and
Proof of Pixels don't name Credits. Punks x Credits was a shill campaign and
was never a candidate.

Next steps for the perk search: resolve t.co links and fetch quoted and parent
posts automatically, normalise dedupe keys to project plus canonical domain,
check claim contracts against the Credits contract
(`0x97630aa70ab14ed9883b41dafccbc11349723043`), and add `-"80% supply"` to the
strong-terms query to cut the burn-80 memecoin spam.
