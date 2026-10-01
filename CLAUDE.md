# mooch.agency

Static HTML site. No build step, no framework. Each page is a standalone `.html`
served as-is (Vercel, `cleanUrls`). Shared styling lives in 4 root files; anything
page-specific stays inline in that page's `<style>`.

## Design system

Before building any UI, read `tokens.css`, `ui.css` and `styleguide.html`, and
reuse what's there before inventing anything new.

- `tokens.css` colour, type, spacing, motion timing. Never hardcode a colour, size
  or duration in a page. A new value goes here first, even on its first use. This
  is the rule that stops drift.
- `motion.css` entrance motion (`.reveal`, word stagger, `.rise`) plus the
  reduced-motion guards.
- `ui.css` buttons (`.pill`, `.ghost`).
- `motion.js` declarative entrances (`data-stagger`, `data-reveal`), loaded only
  by pages that use those attributes (homepage, axbeat).

Full reference: `docs/design-system.md`. Rendered, living version: `/styleguide`.

### Adding a component
- One-off: keep it inline on the page.
- Reused: on the second or third use, promote it into shared CSS and use the class
  everywhere (rule of three).
- When you promote something to shared CSS, add it to `styleguide.html` in the same
  commit, so the guide stays a mirror of what actually ships. Don't add page-local
  one-offs to the styleguide.

### New page
Copy `case-study-template.html` (or `index.html`). Keep the shared `<link>`s in the
head, in order: `tokens.css`, then `motion.css`, then `ui.css`. Add `motion.js`
before `</body>` only if the page uses `data-reveal` / `data-stagger`. Put only
page-specific layout in the inline `<style>`. Add public pages to `sitemap.xml` and
`llms.txt`.

Every public page ships its own share card, and **creating it is part of
creating the page, never a separate ask**: whoever builds a page (usually
Claude) adds a `card` block to `mooch-cards/og-site.sh` in the same change, with
eyebrow/title/subtitle drawn from the page's own hero copy, runs `pnpm
cards:build`, and points the page's `og:image` / `twitter:image` at the card
(with width, height and alt). Tahi and Natalie never do this by hand.

`pnpm cards:build` renders every card straight to its `og-<slug>.png` in the
repo root and stamps the URLs, so there is no copy step. CI is the safety net,
not the instructions: `check-site` fails a shipped page without a resolving
`og:image`, and `stamp-cards --check` fails a stale or missing stamp, so a page
cannot ship cardless or stale even if this paragraph is ignored. First run
needs the renderer's deps (`cd mooch-cards && pnpm install`); to eyeball a card
before it lands, `./mooch-cards/og-site.sh /tmp/preview`. `og-image.png` is the
brand card and the fallback only.

`mooch-cards/` here is a vendored copy of the renderer from the private
mooch-cards repo, which Natalie also uses for brand assets. The split is by
ownership: **card definitions live only here** (`og-site.sh` is site content and
versions with the pages), **brand assets live only there**. The renderer exists
in both on purpose, which pins the site's cards to a known engine and keeps them
reproducible from this repo alone. To take a rendering improvement, copy the
changed file across deliberately.

Then run `pnpm cards:stamp`. Card URLs carry a `?v=<content-hash>` stamp, because
Telegram, X and LinkedIn cache preview images by URL and never revalidate one they
have already fetched. Reusing a filename for new artwork is how the site ended up
serving a card from months earlier on every platform at once. The stamp makes a
redesigned card a new URL, so this cannot recur, and `pnpm ci:check` fails on a
stale stamp.

Retiring a card: never let its URL start 404ing. Add a redirect in `vercel.json`
so snapshots cached elsewhere resolve to something current, then the file itself
can go (Vercel matches redirects before the filesystem, so the redirect works
either way). Point the destination at a card, not at a bare filename: `cards:stamp`
stamps redirect destinations too, precisely so a retired URL cannot hand a crawler
back the unstamped key it was already caching.

## Paths and subdomains

One rule: **the address follows the code.**

- **Code in this repo gets a path**, `mooch.agency/<slug>`. Case studies,
  prompts, offer pages, and free tools that exist to show what Mooch does
  (Say Less, Write like Paul Graham, Credit Cards).
- **Code with its own repo and Vercel project gets a subdomain**,
  `<slug>.mooch.agency`, or its own domain. Products and playthings with their
  own code, deploys, payments or users (FRWA, samantha, Monitoring the
  Situation), plus infrastructure (`notion-webhook`).

For something new, ask: does it sell Mooch, or does it run as its own thing? If it
sells Mooch, build it here and ship it as a path. If it runs as its own thing, give
it its own repo and its subdomain from day one.

Two things this rules out. Never serve a page from this repo on a subdomain: a
host rewrite makes one app look like two, and splits its analytics. Never copy
another project's pages in here: the copy drifts from the real one. When
something moves, leave a permanent redirect from the old address in
`vercel.json`. Older playthings still on `*.vercel.app` addresses are a known
exception, left as they are.

## Analytics

Vercel Web Analytics is on. Every shipped page loads `analytics.js`, which is a
loader, not the vendor script: it honours a per-device `?notrack=1` opt-out so
our own browsing doesn't pollute numbers this small. Internal pages (styleguide,
templates, portfolio explorations, stagger-tuner) deliberately have no analytics.

Custom events are the point, not pageviews. A new page ships with the clicks
that matter already instrumented, in the same change as the page. Conventions:

- `snake_case` names, scoped by surface where a page owns a flow (`sayless_ask`,
  `sayless_result`). One name per intent: two buttons that mean different things
  never share an event, which is exactly the bug that made `prompt_copy` a mix
  of "took the prompt" and "installed the skill".
- Custom fields go under `data`, flat. Vercel allows strings, numbers, booleans
  and null only, no nesting, 255 characters per name, key and value.
- Guard the call (`try { if (window.va) ... }`), so a blocked script never
  throws into the page.

Reading the numbers: the dashboard, or the query API via the CLI, which needs no
stored token because it uses your `vercel login` session:

```
vercel api "/v1/query/web-analytics/events/aggregate?projectId=<id>&teamId=<id>&since=<ms>&until=<ms>&by=eventName"
```

Note the API has no `hostname` dimension. Until 25 Sep 2026 the Paul Graham
tool was served at `paulgraham.mooch.agency`, so its visits before then report
as `/` and blend into the homepage: split those by event name, not by path.
From that date it reports as `/paulgraham`.

### The copy counter

Prompt pages show how many times the prompt has actually been copied, next to
the copy button (`.copy-cluster` / `.copy-count` in `ui.css`). The number is
baked into the HTML by `pnpm counts:build`, which reads the `prompt_copy` event
for that page's path.

Build time, not request time, and deliberately: Vercel issues no read-only
analytics token, so a page that fetched this on load would mean keeping a
full-account token in production to render one integer. This way the token never
leaves the machine running the script and the page ships static.

The number therefore only moves on deploy, which is fine at these volumes. It is
a floor, not a true total, since it misses anyone blocking the script. A count of
0 hides itself. `pnpm counts:check` fails if a page's number has drifted from
what analytics now reports; it is **not** in `ci:check`, because the count
legitimately goes stale between deploys and would otherwise fail every PR.

## Agent discovery

Three things advertise the site to agents, on top of `llms.txt` and `sitemap.xml`:

- **`Content-Signal` in `robots.txt`** declares how automated systems may use the
  content. All three signals (`ai-train`, `search`, `ai-input`) are `yes` on
  purpose: mooch is found by being read, cited and answered with. It is a
  preference signal, not access control, so it never gates anything.
- **A `Link` header** on every response (set in `vercel.json`) points at
  `llms.txt`, the skills index and the sitemap, so an agent finds them from a
  HEAD request without guessing paths.
- **`/.well-known/agent-skills/index.json`**, the Agent Skills Discovery index
  (Cloudflare RFC v0.2.0), answering "what skills does mooch publish?" from the
  front door rather than only from GitHub.

The skills themselves are **vendored** into `.well-known/agent-skills/`, copied
from `mooch-agency/skills`. That is deliberate, and the same ownership split as
`mooch-cards/`. Every index entry carries a SHA-256 `digest` that clients MUST
verify before using the skill; if the `url` pointed at raw.githubusercontent,
any commit in the skills repo would silently invalidate every digest we serve
and nothing here could detect it. Serving our own copies makes the check
self-contained, so it actually runs in CI.

```
pnpm skills:sync ../skills-repo-staging   # re-copy from a skills-repo clone, then rebuild
pnpm skills:build                          # rebuild index.json + archives from what is vendored
```

A skill that is `SKILL.md` alone ships as `type: "skill-md"`. One with
supporting files ships as a reproducible `.tar.gz` (`type: "archive"`), so its
relative references still resolve; `scripts/agent-skills.mjs` writes the tar by
hand precisely so the bytes, and therefore the digest, never churn between
builds, and gzips at level 0 because compressed deflate output differs between
zlib builds (three Node versions gave three digests for one tar). `pnpm ci:check`
runs `--check` and fails on any drift between a vendored skill and the index
that describes it.

Adding a skill to the public repo is not automatic here: run `skills:sync` and
commit, or the index goes stale and CI says so.

## AXBeat (`/axbeat`)

The public agent-experience board for the top 22 L2s. Two hosts per chain, the
website and the docs, each ranked on how many of Cloudflare's scored
agent-readiness checks it passes, republished unaltered.

`https://mooch.agency/axbeat` is the canonical URL and the only place the board is
served. If a short AXBeat domain is ever bought it becomes a **permanent redirect
here**, never a second copy: two hosts would split the inbound links and hand
search engines a duplicate to pick between. Add it as a `redirects` entry in
`vercel.json`, not as a new page.

The scores are **baked into the page**, not fetched at request time:

```
pnpm axbeat:build ../ax-audit   # re-bake from a local ax-audit clone (pull it first)
pnpm axbeat:check               # verify what is baked; runs in ci:check
```

`scripts/axbeat-data.mjs` is the only bridge to the private `mooch-agency/ax-audit`
repo, and it runs on a machine that has both, never in CI. It reads that repo's
`results/l2-top22-latest.json`, writes two things into `axbeat.html` in one pass
(the JSON block the interactive board reads, and the static no-JavaScript board
above it), and **holds the build** if any row is low confidence: a failed scan, or
any check Cloudflare returned as `unableToCheck`. A week-stale board beats a row
we cannot stand behind. There is deliberately **no GitHub token**: baking and
committing the numbers makes a re-scan a reviewable diff and keeps builds hermetic.

Two rules that are easy to break by accident:

- **Never hand-edit the baked block or the static table.** `axbeat:check`
  regenerates both from the data and fails on any drift, including a row whose AI
  access policy no longer matches the check message it was read from.
- **Cloudflare's `nextLevel.requirements` must never derive a score, a level or an
  ordering.** Its entries carry a `prompt` and a `skillUrl`, which makes it a list
  of suggested fixes for a coding agent rather than a rule, and on this data it is
  demonstrably not the gate: it names Link headers for a 1/5 site while every 1/5
  site fails Link headers. It is not baked or shown anywhere as of 16 Sep 2026:
  the opened row lists which scored checks passed and which did not, verbatim off
  the baked block, with no level names and no advice. Two earlier panel designs
  died and stay dead: derived per-level gates (retired 15 Sep: nothing scored 2/5,
  so gates 2 and 3 came out byte-identical and five scored checks fell in no gate)
  and a pip ladder quoting Cloudflare's advice on the next rung (retired 16 Sep
  with the ladder itself). If the advice ever returns, quoting it attributed is
  allowed; reading it back into a score, level or ordering is not.

Display copy carrying a chain's name or a reader-facing caveat lives in
`scripts/axbeat-chains.json`, keyed by the brand in ax-audit's targets file.
Nothing there can change a score.

Each row has its own link, `/axbeat#<slug>`, which opens that row (added 28 Sep
2026 for launch outreach). The slug is baked from the display name (`ADI Chain` ->
`adi-chain`), so **renaming a chain breaks every link already sent for it**: once
outreach has gone out, treat display names as frozen.

Leads land via `api/axbeat-lead.js` in the same Notion "Inbound Audit Leads" DB as
the homepage audit band (Reviewer: Natalie), so there is one review queue. The
endpoint accepts any work email (the board-domain allowlist was deliberately
dropped 17 Sep 2026: the board is public, so gating on it added nothing); its
guards are local-part syntax, Mailchecker's disposable blocklist, an MX lookup
that fails open on timeout, and per-domain plus global rate limits.

## Credit Cards alerts (paid daily scan)

The standing-order band on `/creditcards` sells a daily email of newly approved
projects at $8 a month, labelled "launch price", charged up front with no
trial. Never show a struck "was" price: $15 was never charged, and a reference
price that never applied is an ASA problem. **Stripe is the subscriber list**:
there is no database.

- `api/creditcards-subscribe.js` POST `{email}` opens a Stripe Checkout
  subscription on `STRIPE_PRICE_ID` and returns `{url}`. The band's form also
  posts there with no JavaScript (form-encoded, answered with a 303 to
  Checkout). Success returns to `/creditcards?subscribed=1`, cancel to
  `/creditcards`. Before opening Checkout it looks the email up in Stripe and,
  if that address already has an active or trialing subscription on our
  price, answers `{already: true}` instead, so nobody is billed twice. That
  answer reveals whether an address subscribes: accepted, for an $8
  newsletter behind a per-IP rate limit.
- `api/creditcards-digest.js` is a Vercel cron, `0 7 * * *` in `vercel.json`:
  07:00 UTC, so 7am GMT and 8am BST, chosen over DST-switching crons. It 401s
  without `Authorization: Bearer $CRON_SECRET`. It reads the bundled
  `data/creditcards.json`, picks approved projects whose id isn't in the sent
  state, and emails every active or trialing subscription on our price via
  Resend, one email per person, idempotency-keyed. Nothing new, no email.
- State is one private blob, `creditcards-digest/state.json` (`{ sentIds }`).
  **The first run seeds it with every approved id and sends nothing**, or
  launch day would mail the whole index. After a send it advances unless the
  run hit an infrastructure failure (recipient fetch, Blob write, a Resend
  5xx, a 429 that survived the retry, a network error, or every send
  failing). Failures that are only per-recipient (a Resend 4xx for some
  addresses) still advance it: those
  people miss that day's items for good, rather than one bad address
  replaying a growing digest to everyone else daily. The run summary carries
  `failedRecipients`. A withheld run is safe to re-run by hand within 24h
  (Resend drops repeats by key, and a 409 counts as already sent):
  `curl -H "Authorization: Bearer $CRON_SECRET" https://mooch.agency/api/creditcards-digest`.
- `api/creditcards-portal.js` is where Manage, Unsubscribe and the
  `List-Unsubscribe` header point. Links carry an HMAC of the Stripe customer
  id (keyed off `STRIPE_SECRET_KEY`), so they can't be forged from an email
  address; anything unsigned goes to Stripe's portal login page instead. No
  lookup by email, so no enumeration here. The band and the post-checkout
  confirmation link to it unsigned ("Manage"), so a subscriber can manage
  before their first scan arrives: set `STRIPE_PORTAL_LOGIN_URL`, or that
  link lands on a "check your email" page.
- The rules live in `api/_creditcards-digest.js` with every side effect
  injected; `pnpm test` covers selection, subject, email HTML, the state
  rules, the Checkout shape (no trial) and the already-subscribed lookup with
  no keys. Email colours mirror `tokens.css` by hand (mail clients
  can't read it).

Env on the Vercel project: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`RESEND_API_KEY`, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN` (a **private** Blob
store), plus optional `STRIPE_PORTAL_LOGIN_URL` (the portal's login link). The
portal configuration exists in both Stripe modes (created via the API, ids in
the Keystore). With no Stripe key the band answers "not open yet" (503).
Checkout returns to production, or to the dev server / Vercel preview that
opened it, so a preview can be tested end to end with the test key.

## Voice
British English, terse, no em dashes. Full house style: MOOCHBOT.md in Notion.

## Privacy
Don't commit Tahi's personal email address anywhere: repo docs, code, or commit
metadata. Commit as `Claude <noreply@anthropic.com>`. The brand and public
contact (the business email, social handles, the husband-and-wife framing) are
intentional and stay.
