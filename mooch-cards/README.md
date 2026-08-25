# mooch-cards

Branded card generator using Satori. PNGs for LinkedIn, Substack, Twitter/OG.

> Vendored here, in the public mooch.agency repo, so the site's `/og-*.png`
> cards rebuild from this repo alone. Run them with `pnpm cards:build` from the
> repo root: that renders every card straight into place and stamps the URLs.
> `og-site.sh` holds the card definitions and lives only here.
>
> `assets/` (avatars, LinkedIn banners, team photos) is intentionally left out,
> so any command below referencing `assets/...` needs the full tool: the private
> repo at [mooch-agency/mooch-cards](https://github.com/mooch-agency/mooch-cards).
> A rendering improvement made there reaches the site by a deliberate copy.

Monochrome, Instrument Serif display, no accent colour. Styled to match
mooch.agency: the site's tokens (paper/ink, the serif, the mono labels) are
mirrored in `lib/brand.ts`, so changing a token propagates everywhere.

## Setup

1. `pnpm install` (from this directory; needed once before `pnpm cards:build`)
2. Fonts live in `/fonts/` (already committed). Five static TTFs are needed:
   - `InstrumentSerif-Regular.ttf`, `InstrumentSerif-Italic.ttf` — display type
     (https://fonts.google.com/specimen/Instrument+Serif)
   - `IBMPlexMono-Regular.ttf` — labels, eyebrows, wordmark
     (https://fonts.google.com/specimen/IBM+Plex+Mono)
   - `Inter-Regular.ttf`, `Inter-Bold.ttf` — body copy
     (https://fonts.google.com/specimen/Inter)

   Satori needs local static TTFs. Variable fonts often fail with
   `Unsupported OpenType signature`.

## Templates

9 templates, each with a shortcut script.

### quote

Pull quote with required byline.

```bash
npm run quote -- \
  --text "The making is interesting. The decisions are worth sharing." \
  --author "Mooch"
```

### stat

1 big number, label, optional footnote.

```bash
npm run stat -- \
  --number "73%" \
  --label "of brand audits flag the same 3 issues" \
  --footnote "Mooch brand audit, 2026"
```

### side-by-side (script: `compare`)

2 columns, A vs B. Left muted, right accent. Eyebrow at top.

```bash
npm run compare -- \
  --eyebrow "How Mooch works" \
  --left-title "Old way" \
  --left-body "Decks. Tracker spreadsheet. Endless calls." \
  --right-title "New way" \
  --right-body "Agent kanban. Daily dispatch."
```

### hero

Large title, optional eyebrow + subtitle. Carousel slide 1, Substack hero, OG image.

Same template at any format. Use `--format substack` for landscape Substack hero, default square for LinkedIn carousel slide 1, etc.

```bash
npm run hero -- \
  --eyebrow "Substack: Issue 03" \
  --title "Permissionless beats permitted." \
  --subtitle "Pitch the prototype, not the proposal." \
  --format substack
```

### list

Up to 5 bullets with accent square markers. Eyebrow at top, optional title, bullets centred.

```bash
npm run list -- \
  --eyebrow "How we ship" \
  --title "3 rules for lean teams." \
  --bullet1 "Decisions slow. Delivery fast." \
  --bullet2 "Build the thing. Then see who notices." \
  --bullet3 "Taste makes the call. Research backs it up."
```

### definition

Dictionary-entry-as-poster. Term in massive accent, 1-line body in white. The Visualize Value classic.

```bash
npm run definition -- \
  --eyebrow "Definition" \
  --term "Permissionless" \
  --body "The default. Build the thing, then see who notices."
```

### hook

Carousel slide 1 alternative. Hero-sized text + "SWIPE →" indicator at the bottom-right. Pass `--no-swipe` to suppress the indicator.

```bash
npm run hook -- \
  --eyebrow "Issue 03" \
  --text "What if your sales calls already had the answer?"
```

### cta

Outro / last slide of every carousel. Prompt in white, link/handle in accent.

```bash
npm run cta -- \
  --eyebrow "More like this" \
  --prompt "Read the rest of the piece." \
  --link "mooch.agency/issue-03"
```

### steps

Numbered list (01, 02, 03...) for ordered processes. Like `list` but order is the point.

```bash
npm run steps -- \
  --eyebrow "How we ship" \
  --title "4 steps from idea to launch." \
  --step1 "Audit. What's the actual problem?" \
  --step2 "Brief. One page, no jargon." \
  --step3 "Build. Prototype before pitch." \
  --step4 "Ship. Then see who notices."
```

### portfolio

Case-study / client card. Client name up top (ink, real casing, tick-led), the
work as a bold serif statement. Client is clear, statement carries.

```bash
npm run portfolio -- \
  --name "gov.uk" \
  --work "Designing government digital services that *millions* rely on every day."
```

### team-cover / team-member

Team cards, editorial like the rest of the kit: mono tick eyebrow, avatar, big
left-aligned serif. `team-cover` is a row of avatars over one serif line;
`team-member` is an avatar, serif name, one-line sans role. Avatars are circular
and rendered greyscale to stay monochrome; a missing file falls back to an
initial-in-a-ring placeholder.

```bash
npm run team-cover -- --eyebrow "The team" --line "Two humans and one *agent.*" \
  --avatar1 assets/avatars/tahi.png --avatar2 assets/avatars/natalie.png --avatar3 assets/avatars/moochbot.png

npm run team-member -- --eyebrow "The team" --name "Tahi" \
  --role "Starts things and ships things. Content design, AI agents, the products you can try." \
  --avatar assets/avatars/tahi.png
```

## Formats

| Flag | Size | Use |
|------|------|-----|
| `square` | 1080×1080 | Default. Cross-platform: LinkedIn, Substack, X, Instagram |
| `portrait` | 1080×1350 | 4:5 portrait. Max LinkedIn impressions when content has weight |
| `substack` | 1456×816 | Substack hero, post inline |
| `og` | 1200×630 | Twitter, default OG |

Default is `square`. Every template scales to every format.

## Flags

A flag is an option you add after `--` to change how a card comes out. Every
flag is optional: a plain card is just the template plus its content. Flags in
plain English:

**Content** (varies by template): `--text`, `--title`, `--author`, `--number`,
`--label`, and so on, as shown in each template's example above. To italicise
one word (the Mooch emphasis move), wrap it in asterisks: `--title "beats
*permitted*"`.

**Look:**

| Flag | What it does |
|------|--------------|
| `--format square` | Card shape. `square` (default), `portrait`, `substack`, `og`. See the Formats table. |
| `--dark` | Black background, white text. Good for an opener or closer. |
| `--tint <name>` | Faint colour wash instead of white: `prompt` (lilac), `plaything` (warm), `product` (cool grey), `ai` (blue). |
| `--scale <n>` | Multiplies the main display size. `--scale 1.6` for a frame-filling hook/cta. Applies to hero, hook, cta, portfolio. Default 1. |
| `--no-footer` | Drop the footer (rule + wordmark). Use on a cta whose link already shows the domain, so it isn't repeated. |
| `--frame` | Hairline rounded frame inset from the edge. The mooch.agency share-card house style. |
| `--meta <text>` | Footer-left context, uppercase mono. Pairs with `--domain`. |
| `--domain <text>` | Footer-right domain, uppercase mono in full ink. Switches the footer to the share-card two-column form. |

### Share cards for mooch.agency

The site's OG cards all follow one template: hairline frame, mono eyebrow with
a leading tick, Instrument Serif display, and a footer running context on the
left against the domain on the right. `--frame --meta --domain` reproduces it.

**`og-site.sh` is the source of truth** for every live card's exact copy and
scale; adding a page to the site means adding one `card` block there and
rerunning it. The shape of a card command, for reference only:

```bash
npm run hero -- --eyebrow "Prompt" --title "Make Claude\n*say less.*" \
  --subtitle "Cut Claude Code replies by ~71%." \
  --format og --frame --dark --scale 1.15 \
  --meta "London / Lisbon" --domain "mooch.agency/say-less"
```

`\n` in a title or subtitle forces a line break where the break position
matters. Watermarks are automatically suppressed on framed cards (the frame
can't clip: `overflow: hidden` with `borderRadius` panics resvg).

**Watermark** (the big faint mark in the corner). Each template picks its own
relevant mark automatically, so usually you do nothing:

| Card | Mark | Shown |
|------|------|-------|
| quote | opening + closing `"` | always |
| definition | the term's first letter | always |
| list / steps | the item count | always |
| hook | `?` | only if the text ends in a question mark |
| cta | `→` | always |
| stat | `↑` / `↓` | only with `--trend up` or `--trend down` |
| hero / side-by-side | none | — |

Override with `--mark "X"` (any glyph you like) or remove it with
`--no-watermark`.

**Carousel numbering** (only if the card is one slide of a set):

| Flag | What it does |
|------|--------------|
| `--index 2 --total 9` | Adds `N° 02 / 09` top-right and a page count bottom-right. Leave both off and a standalone card stays clean, no numbers. |

**Output path:**

```bash
npm run quote -- --text "..." --author "..." --out cards/march-launch.png
```

Otherwise it auto-names one: `out/<template>-<format>-<timestamp>.png`.

**Stacked example** — a dark stat card, up-arrow, custom filename:

```bash
npm run stat -- \
  --number "73%" \
  --label "of audits flag the same 3 issues" \
  --trend up \
  --dark \
  --out cards/audit-stat.png
```

## Carousel composition

Typical 5 to 10 slide carousel:

1. **hook** or **hero**: grab attention
2. **definition** or **stat**: anchor the concept
3. **side-by-side** or **list** or **steps**: the substance
4. **quote**: pull-quote from the piece
5. **cta**: link to the rest, follow, or book

Mix and match. Every slide a poster.

## Adding templates

Live in `lib/templates/`. Each is a function: takes content + size, returns a Satori-compatible element.

Most render their content through the shared `Card` wrapper in `lib/layout.tsx`,
which supplies the chrome (tick eyebrow, footer rule, wordmark, watermark, dark
and tint handling). Display text goes through `Serif` in `lib/type.tsx`, which
handles the `*asterisk*` italic emphasis and mono labels.

To add one:

1. Copy `quote.tsx` (or whichever pattern fits), rename, edit the layout
2. Wrap the content in `<Card>` and pass a relevant `mark` if one fits
3. Import + add a case in `card.ts`
4. Add a script in `package.json` if you want a shortcut

Suggested next templates:

- **testimonial**: quote variant with role / company
- **index**: TOC slide for long carousels
- **before/after image**: photo or screenshot pair (Satori limitation: requires base64 image embed)

## Brand tokens

`lib/brand.ts`, mirrored from mooch.agency `tokens.css`. Monochrome palette
(paper/ink/muted/hairline plus a black colophon variant), Instrument Serif for
display, mono for labels, Inter for body. No accent colour: hierarchy comes from
serif-vs-sans, scale, and ink-vs-muted. Inter and IBM Plex Mono stand in for the
site's system sans and mono, which aren't embeddable.

## Sharp edges

- Satori only supports flexbox. No grid. No transforms. No half of CSS.
- Every `<div>` with children needs `display: 'flex'`. Including divs that just hold a string.
- No React fragments (`<>...</>`) as layout children. Satori doesn't flatten them, so the zones leak. Use a real wrapper div.
- Fonts must be local TTF/OTF files loaded as Buffer. No remote URLs.
- Long text doesn't auto-fit. Cap input length per template.
- Variable fonts (the kind Google Fonts and `@fontsource` ship by default) often fail with `Unsupported OpenType signature`. Use static TTFs.

## When this graduates

Move to a Next.js app and a Vercel deploy when:

- Notion needs to call it (button on a database row)
- A live site needs auto-OG images
- Nat needs to use it without your terminal
