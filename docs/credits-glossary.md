# Credits glossary

The vocabulary of Jack Butcher's Credits and the community building on it. Two
jobs: a reference for people reviewing /creditcards, and the source of truth for
the discovery search terms in `data/creditcards-search.json`. A term only goes
into a query or a scoring rule once it is in this file, and
`scripts/creditcards-search.test.mjs` fails if the config names a term that is
not here.

Sources, read 29 Sep 2026: jack.art/credits, jack.art/credits/rating, the OpenSea
collection API, the blurbs and post text of every entry in
`data/creditcards.json` (approved, pending and rejected), and the full text of
their announcement posts.

## Search value

Every term carries one of these.

| Value | Meaning | How discovery uses it |
|---|---|---|
| **strong** | On its own it almost always means Credits. | Query anchor, no co-term needed. |
| **medium** | Means Credits only next to "credits" (or another strong term). | Query term inside a `credits (...)` group; small score bonus. |
| **weak** | Real vocabulary, but everywhere else too. | Never a query term. Scoring or category hints only. |
| **noise** | Marks spam, coins or unrelated finance. | Query exclusion (`-term`) or a score penalty and a flag. |

## Core terms

| Term | Definition | Search value | Notes |
|---|---|---|---|
| Credits | The artwork by Jack Butcher, and the name of the collection. "From Latin credere: to believe, to trust." An open edition on Ethereum. | medium | Alone it matches film credits, AI credits, tax credits and "credits to @x". Only a query term next to an anchor or a community term. |
| Credit | One token in the collection. Each is a complete artwork. | weak | "credit" is the most generic word in finance. Never a query term alone. |
| Jack Butcher, `@jackbutcher`, jackbutcher | The artist. Also behind Visualize Value, Checks and Opepen. | strong (with "credits") | Nearly every real announcement tags him (32 of the 34 readable approved posts). He posts about far more than Credits, so a query pairs him with a Credits word. His own posts are not community projects (Credit Ratings is the one listed exception). |
| jack.art/credits | The official site: mint explainer, Statement assembly, Credit Ratings (`/credits/rating`). | strong | `url:"jack.art/credits"` catches posts that link the site without naming him. `jack.art` is blocklisted as a candidate URL: it is the source, not a project. |
| Contract `0x97630aa70ab14ed9883b41dafccbc11349723043` | The Credits contract on Ethereum mainnet (per OpenSea). | strong | Appears in explorer links and bot posts. As a search term it pulls sales bots too, so scoring still applies. |
| OpenSea slug `credits` | opensea.io/collection/credits. Created 23 Sep 2026, category art. | strong | `url:"opensea.io/collection/credits"`. The collection page itself is never a candidate (`OPENSEA_OWN_SLUGS`), but a derivative's collection page is. |
| X Money, $8 | Each eligible $8 payment through X Money mints one Credit. | medium | "x money" alone is X's payments product news. Also the mechanic other projects copy (BITS: send $8 on Solana). |
| Transaction ID, SHA-256, 256 bits | The X Money transaction ID is hashed with SHA-256; the 256 bits drive the artwork. | weak | Good for scoring an explainer post, useless as a query term. |
| 8 x 8 grid, `8x8` | Each 64-bit quarter of the hash is one 8 by 8 grid. | medium | Pair with "credits". Written 8x8, 8×8 and "8 × 8". |
| CMYK | The four grids are cyan, magenta, yellow and black: print plates. | medium | Print and design posts use CMYK constantly. Pair with "credits". |
| Plates (cyan, magenta, yellow, black) | The four 64-bit layers. The payment timestamp selects which plates show on a given Credit. | weak | Derivatives lean on it (Debits prints the plates a Credit did not show, 3D Credits goes "plate by plate"). |
| Eights | Each 8 in the X Money transaction ID registers visually. Also a Credit Ratings trait, weighted double. | weak | |
| Traits: palette, active bits, occupied cells, eights, print | The five traits Credit Ratings scores. Palette is a plate combination (C, M, CM, ... CMYK). Print is one of Registered, Slip, Drift, Nudge, Loose, Skew. | weak | Useful in scoring rarity tools; too generic to search. |
| Misregistration, overprint | Statements overprint: burn one Statement onto another, ink adds up, colours multiply, "misregistration prints where it falls". Any Statement can be overprinted any number of times. | medium | "overprint" with "credits" is specific. |
| Statement | The second artwork: burn 80 Credits to compose one, one Credit per cell. | medium | In finance a "statement credit" is a card refund, the single biggest noise source for this word. Pair with "credits" and exclude "statement credit(s)". |
| Burn 80, 80 Credits, "your 80" | The Statement recipe: 80 Credits burned, one Statement made. | strong | "burn 80" and "80 credits" are almost never anything else. Also how derivatives describe their own burns ("burn 80 debits"). |
| Statement assembly, 1 Oct | Burning opens 1 October 2026, 8pm ET (2 October, 01:00 Lisbon time). | medium | Expect a spike of builder posts and tools ("statement builder", "stranded credits") around it. |
| 1,526 Statements | Maximum supply of Statements. The minimum is 1. | strong | "1,526" is a distinctive number. 122,154 / 80 is 1,526.9, hence the cap. |
| 122,154 | The frozen original edition size, used by Credit Ratings and repeated in almost every tool post. OpenSea shows the live supply (122,153 on 29 Sep) as burns begin. | strong | Also written 122154 and 122k. |
| Credit Ratings | Jack's official rarity index at jack.art/credits/rating, methodology v3.4.0. Score = 80 + 720 × (N − rank) / (N − 1), so 80 to 800; #11469 ranks first. | medium | "credit rating" alone is finance. Many tools say "official score", "official ranking" or "Jack's formula". |
| Score 80 to 800 | The Credit Ratings scale. | weak | |
| AAA to CCC | Letter grades. Not official: Credit Check's own grades laid over the official score. | noise alone, weak with "credits" | Bond ratings and finance posts. Never a query term. |
| Open edition, mint | How Credits was issued. | weak | Every NFT post says mint. Category hint for "markets". |
| Creator fees, visualizevalue.eth | Royalties go to Jack's Visualize Value address; several token projects route fees to it. | weak | A tell for tokens and strategies, see Noise. |

## Community slang and derivative terms

| Term | Definition | Search value | Notes |
|---|---|---|---|
| Debits (Wubbushi) | exaltedlove.com/debits, by @wubbushi. "From Latin debere: something owed." Debit #N prints the plates Credit #N kept. States: Owed (apart), Rich (same wallet), Settled (Credit burned). Films and The Second Hand clock sit under it. | strong (with "credits") | Approved. Two unrelated projects use the name, see below. |
| Debits (permissionless derivatives) | permissionlessderivatives.com/debits, by @jamesrichardfry. "Every Credit implies a Debit." 48 hour open edition at 0.0003 ETH, 80% of mint proceeds buys Credits, burn 80 Debits to claim one Arbitrage and one Credit, burning ends 31 Oct, leftover Credits airdropped to holders. | strong (with "credits") | The miss that started this glossary: an image-only post with no link. Its link is the author's bio. |
| Arbitrage | The artwork you get for burning 80 Debits (permissionless derivatives). | weak alone, strong with "debits" | Trading posts use it hourly. |
| Permissionless derivative | Self-description of work built on Credits without Jack's involvement. Also @jamesrichardfry's site name. | medium | Rare phrase, worth a query slot. |
| Stranded credits | Credits sitting in wallets with fewer than 80, so they cannot make a Statement (a builder counted 80,890 on 27 Sep). | strong | Coined in the community; tools to pool or sell them will use it. |
| Credit Union | Pool Credits with other holders until the pool hits 80 (creditunion.fun). Also the generic idea. | medium | "credit union" is a bank type, pair with "credits". |
| Statement builder, statement studio, composer | Tools to arrange 80 Credits before burning. Two listed projects use these names. | medium | Generic nouns; pair with "credits". |
| Credit score, credit check, credit report, credit history, credit limit | Finance puns used as project names (Credit Scores, Credit Check, Credit Limit) and as slang for a Credit's rating. | weak | Personal finance floods all of them. Scoring hints only, never query terms without "credits" plus a community term. |
| Creditor, top creditors | This site's word for builders on the /creditcards leaderboard. | weak | Rarely used on X; finance noise. |
| Credit Miles | Frequent flyer points per hour held (Wubbushi). | medium | |
| Game of Life seed | Credit Check's discovery that each Credit's grid seeds Conway's Game of Life. | medium | |
| "no wallet needed", "nothing to connect", "read-only" | How builders reassure holders their tool is safe. | weak | Good positive scoring signal for real tools. |
| built, made, vibecoded, shipped, "try it", "check it out", "now live", "goes live" | Announcement verbs. | weak | Gate for the author-bio fallback: a linkless post with a strong Credits term and an announcement verb borrows the bio link. |
| Tool hosts: vercel.app, netlify.app, github.io, here.now, workers.dev, kimi.page | Where most community tools are hosted (3D Credits, CR3DITS, Credits Monitor, Pour, Credits Cube, Credits Factory, Credits Rarity Checker). | medium (with "credits") | Nine approved posts never tag Jack; most of those link one of these hosts. Tier C pairs `credits` with `url:` on each host. |
| "link in bio", "link in the first comment", "link below" | Where the link went when the post has none. | weak | Triggers the bio fallback or the self-reply thread lookup. |
| $CREDITSTR, Credit Strategy | TokenWorks' strategy token (tokenstrategy.com, token 0x8e607209899b5d12bd3167a6cd0e8e11feb053d6): trade tax buys and relists Credits. | medium | Approved as a project; posts about its price are coin talk and flagged. |
| $JACKOFF | A memecoin themed on Credits, pushed by @mememaxxers on Robinhood Chain, with bounties for Credits articles and apps. | noise | Anthems, market-cap simulators and "scenario desks" for it arrive weekly. Keep it out of queries, flag as coin. |
| $CREDITS (Robinhood Chain) | Unofficial memecoin, contract 0x39679b59289cce7c7f6e0feacdf39a1e543de751. | noise | Behind all the gmgn.ai spam, often in Chinese. |
| $CREDIT (Solana) | Unofficial pump.fun coin, CA CXpCREMe9NYtQzJikaPKuVmXD58ZeCnVdiUjKyuEAP7a. | noise | Signal bots post it. |
| BITS, $BITS | Solana collection that copies the $8 mechanic (buybits.art). | medium | Approved. |
| Credit Cards | Two meanings: this site's index (mooch.agency/creditcards, run by @jesusdoteth), and @Jehoseph's separate OpenSea collection "Credit Cards". | noise as a query term | "credit card" is the biggest finance noise term on X. Never search it. |
| VV, Visualize Value, `@visualizevalue` | Jack's studio and brand. | weak | Mostly about other VV work. |
| Checks, Opepen | Jack's earlier editions. | noise alone | Useful only as style references ("opepen inspired by credits"). |

## People

| Handle | Role | Search value | Notes |
|---|---|---|---|
| @jackbutcher | Artist, Credits and Credit Ratings. | strong anchor | Excluded from the top creditors board. |
| @visualizevalue | Jack's studio account. | weak | |
| @jesusdoteth | Tahi, runs /creditcards. Builders submit by replying to the Credit Cards thread. | strong for the replies source | Own posts excluded from the replies query. |
| @wubbushi | Debits (exaltedlove.com), Credit Scores, Credit Miles, The Second Hand. | builder | Most prolific. |
| @devonfigures | Creditizer and Credit Scanner (creditscores.vercel.app). | builder | |
| @JimEagle_ | Credit Check (AAA to CCC grades, Game of Life). | builder | |
| @Jehoseph | Credit Cards collection and Creditmon, on OpenSea. | builder | |
| @bigvibessss, @taylor_ | Credit Union. | builders | |
| @token_works | Credit Strategy ($CREDITSTR). | builder | |
| @jamesrichardfry | Debits, permissionless derivatives. | builder | Bio link: permissionlessderivatives.com. |
| @mememaxxers, @tradesgiving, @kenZaii7 | $JACKOFF and strategy-token promotion. | noise | Occasionally tag a real tool; review by hand. |

## Projects

Approved on 29 Sep 2026, by category. The live list is `data/creditcards.json`.

- **Rarity and data:** Credit Ratings (jack.art/credits/rating, @jackbutcher), creditsmoonmath.xyz (@himars), credits.ninja (@itsmemeworks), Credits Intelligence (@SickAssPen), Credits Lab (@0xJohnB), Credit Check (@JimEagle_), Credits Monitor (@Dorsian), Credit Miles (@wubbushi), Credit Scanner (@devonfigures), Credits Rarity Checker (@0xlalitmehra).
- **Art and remixes:** 3D Credits (@avsingh_eth), Debits (@wubbushi), Creditizer (@devonfigures), Pour (@dealer1943), CR3DITS (@heyflaw), Credit // Killers (@DTODDART), Creditpepen (@LikeLewis), Credit Scores (@wubbushi), Credonauts (@timsouw).
- **Build your Statement:** Credit Union (@bigvibessss, @taylor_), Statement Studio (@ivdoublex), Credits Factory (@4484), Statement Builder (@Caben_nft).
- **Games:** Credit Limit (@0xhiromasa), Credits Cube (@winchxyz), MOD80 BREAK (@intr3pico).
- **Mints, tokens and markets:** Sight (@sight_hood), Credited Punks (@defimaestro90), BITS (@EightBits11), Futures (@LATE_FX), Credit Strategy (@token_works), Credit Cards (@Jehoseph), Creditmon (@Jehoseph).
- **Found but not yet listed:** Debits by @jamesrichardfry (permissionlessderivatives.com/debits), punk.it CryptoPunks from Credits, a stranded-credits tool from @mylesdaughtry due after 1 Oct.

## Noise patterns

What the rejected and low-scoring entries have in common, and how discovery
handles each.

| Pattern | Examples from the data | Tells | Handling |
|---|---|---|---|
| Memecoin charts and wallet trackers | gmgn.ai links from @qkdsb666, @tony080226, @linda6248130564 (all the Robinhood Chain $CREDITS coin) | gmgn, "现价", "合约", CA:, market cap, DYOR, a 0x or base58 address, $TICKER | `-gmgn` in queries; `gmgn.ai`, `dexscreener.com` etc. in `DENY_HOSTS`; `coin` flag, score −2 to −3. |
| Launchpads and signal bots | pump.fun ($CREDIT signal bot @bitecong), ponsfamily.com launchpad (@kenZaii7) | "AI Signal", "minutes old", launchpad, presale, 100x | pump.fun is deny-listed; `coin` flag. |
| Coin-adjacent tools | jackoff-simulator.netlify.app, Credits × $JACKOFF scenario desk, a $JACKOFF Suno anthem | $JACKOFF, @mememaxxers, "market cap simulator" | Reach review with the `coin` flag; a human decides. |
| Airdrop and free-mint spam | ether-bunnys-club ("Top 1 holder win 2 ethereum airdrop!"), Blackswan ("Credits to @jackbutcher" as a credit line) | #Airdrop, #freemint, "win", hashtag walls, "Credits to @" | Score penalty for hashtag walls and "credits to"; never exclude "airdrop" in a query, the Debits post uses it. |
| Trading and mentorship spam | t.me and tiny.cc links from @gainzry22 | "mentorship", "copy my trades", DM, t.me | `t.me` deny-listed; `-mentorship` in queries. |
| Unrelated products tagging Jack | Home Office OS, chainhawk.io alerts, trover.tech trackers | Pitch aimed at "degens who aped", generic tracker | Human review; `known-host` style flags do not catch these. |
| Writing about Credits | catalogue.gallery blog post | /blog/, medium.com, substack | `article` flag. |
| Generic credit card and personal finance | Not yet in the data because the current query never lets it in, but it is what "credit score", "statement credit", "credit card", "credit limit", "AAA" return | Amex, Chase, cash back, points, annual fee, APR, FICO | Excluded in every query that does not anchor on Jack: `-"statement credit" -"statement credits" -cashback -"cash back" -amex -fico -apr`. |
| AI and SaaS credits | Not in the data yet: "free credits", "API credits", "ran out of credits on Lovable/Replit" | lovable, replit, free credits, api credits, tokens, usage | Excluded in Tier C, which pairs "credits" with tool hosts: `-lovable -replit -"free credits"`. |
| Sub-pages of a listed project | creditscheck.xyz/life, creditscheck.xyz/browse/all | same host as an approved entry | `known-host` flag, −1. |
