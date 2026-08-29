#!/usr/bin/env bash
# Regenerates every mooch.agency share card from the one house template.
#
# The template is the homepage card: hairline frame, mono eyebrow with a leading
# tick, Instrument Serif display, and a footer running context on the left
# against the domain on the right. Nothing here should deviate from that; if a
# page needs a different shape, change the template, not one card.
#
#   pnpm cards:build            # rebuild + stamp every card, in place
#   ./mooch-cards/og-site.sh /tmp/preview   # render elsewhere to compare first
#
# This file exists ONLY here. The private mooch-cards repo has the same renderer
# (Natalie uses it for brand work) but no og-site.sh, so there is nothing to keep
# in sync: card copy is site content and lives with the pages it describes.
#
# The renderer alongside it is a vendored copy, which is deliberate. It pins the
# cards to a known engine, so they stay reproducible from this repo alone with no
# network and no access to a private repo. To take a rendering improvement from
# mooch-cards, copy the changed file across on purpose.
#
# Adding a page = one card block below: name, eyebrow, title, subtitle, domain.
# Frame, footer meta and format come from card(); watermarks are suppressed on
# framed cards by the renderer itself. Pick --scale so the text block clears the
# footer, then eyeball the PNG (satori has no auto-fit).
#
# `pnpm cards:build` runs this and then stamps every URL with a hash of the new
# bytes. That stamp is what stops Telegram and X serving a card from months ago.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# No argument: write each card straight to the name the site serves it under, so
# building IS installing and there is no copy step to forget. Pass a directory to
# render into that instead, for previewing or diffing without touching the site.
PREVIEW="${1:-}"
[ -n "$PREVIEW" ] && mkdir -p "$PREVIEW"
COUNT=0

if [ ! -x "$HERE/node_modules/.bin/tsx" ]; then
  echo "Renderer deps missing. Run: cd \"$HERE\" && pnpm install" >&2
  exit 1
fi

# Shared template chrome. A card can still override any flag (last one wins),
# e.g. a different --meta for a card whose footer context isn't the house line.
card() {
  local name="$1"; shift
  local out
  if [ -n "$PREVIEW" ]; then
    out="$PREVIEW/$name.png"
  elif [ "$name" = "home" ]; then
    out="$ROOT/og-image.png"   # brand card, and the site-wide fallback
  else
    out="$ROOT/og-$name.png"
  fi
  # --tsconfig is explicit so this runs from anywhere: tsx looks for a tsconfig
  # relative to the working directory, and without the JSX settings in ours it
  # falls back to the classic transform and dies with "React is not defined".
  "$HERE/node_modules/.bin/tsx" --tsconfig "$HERE/tsconfig.json" "$HERE/card.ts" hero \
    --format og --frame --meta "London / Lisbon" \
    --out "$out" "$@" >/dev/null
  COUNT=$((COUNT + 1))
  echo "  $name"
}

echo "Brand"
# Subtitle is the homepage hero deck, verbatim, so the card and the page agree.
card home \
  --eyebrow "AI automation & UX" \
  --title "*Mooch.*" \
  --subtitle "We design products people want to use,\nand AI automations they can't live without." \
  --domain "mooch.agency" \
  --scale 1.45

echo "Playthings and tools"
card say-less \
  --eyebrow "Claude Code Plugin" \
  --title "Make Claude\n*say less.*" \
  --subtitle "Say Less cuts Claude Code fluff by 71%." \
  --domain "mooch.agency/say-less" \
  --dark --scale 1.15

card paulgraham \
  --eyebrow "Plaything" \
  --title "Write like\n*Paul Graham.*" \
  --subtitle "Write articles as clearly as Paul Graham." \
  --domain "paulgraham.mooch.agency" \
  --scale 1.15

card deslop \
  --eyebrow "Prompt" \
  --title "*/deslop*" \
  --subtitle "Remove the red flags of AI writing." \
  --domain "mooch.agency/prompts/deslop" \
  --tint prompt --scale 1.45

card soundlikeme \
  --eyebrow "Prompt" \
  --title "*/soundlikeme*" \
  --subtitle "Make AI write in your voice." \
  --domain "mooch.agency/prompts/soundlikeme" \
  --tint prompt --scale 1.1

card frwa \
  --eyebrow "Plaything" \
  --title "Trade the\n*FRWA 10.*" \
  --subtitle "24/7 365 on the Mooch Stock Exchange (MSE)." \
  --domain "mooch.agency/frwa" \
  --dark --scale 1.15

# No `ready` card: /ready was retired in the Phase 0 roadmap decision and now
# 301s to /, so a sharer never reaches a page that would use one.

echo "Selected work"

card gov-uk \
  --eyebrow "Selected work" \
  --title "*GOV.UK*" \
  --subtitle "Accessibility audits and service design for services millions rely on." \
  --domain "mooch.agency" \
  --scale 1.6

card british-airways \
  --eyebrow "Selected work" \
  --title "British *Airways*" \
  --subtitle "UX research across BA's digital products, from friction points to fixes." \
  --domain "mooch.agency" \
  --scale 1.15

card ethereum \
  --eyebrow "Selected work" \
  --title "Ethereum *Foundation*" \
  --subtitle "Rewriting ethereum.org in plain English, without losing technical accuracy." \
  --domain "mooch.agency" \
  --scale 1.0

card zksync \
  --eyebrow "Selected work" \
  --title "*zkSync*" \
  --subtitle "UX research for an Ethereum Layer 2: developer experience and bridging." \
  --domain "mooch.agency" \
  --scale 1.6

card octant \
  --eyebrow "Selected work" \
  --title "*Octant*" \
  --subtitle "UX research and product strategy for public goods funding." \
  --domain "mooch.agency" \
  --scale 1.6

card big-debate-club \
  --eyebrow "Selected work" \
  --title "Big Debate *Club*" \
  --subtitle "Brand, product and growth strategy for a youth debate platform." \
  --domain "mooch.agency" \
  --scale 1.1

card lisbon-restaurant-group \
  --eyebrow "Selected work" \
  --title "Lisbon *Restaurant* Group" \
  --subtitle "AI review automation: Google reviews turned into drafted replies." \
  --domain "mooch.agency" \
  --scale 0.95

echo
echo "Wrote $COUNT cards to ${PREVIEW:-$ROOT}"
