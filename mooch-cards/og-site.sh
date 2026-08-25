#!/usr/bin/env bash
# Regenerates every mooch.agency share card from the one house template.
#
# The template is the homepage card: hairline frame, mono eyebrow with a leading
# tick, Instrument Serif display, and a footer running context on the left
# against the domain on the right. Nothing here should deviate from that; if a
# page needs a different shape, change the template, not one card.
#
#   ./og-site.sh [outdir]     # default: ./out/site
#
# THIS COPY IS AUTHORITATIVE for mooch.agency's cards. The standalone mooch-cards
# repo carries the same script for its own brand work, so the two can drift apart
# silently: edit this one, then mirror the change there. If you are checking
# whether they agree, fetch first. A stale clone looks exactly like a divergence.
#
# Adding a page = one card block below: name, eyebrow, title, subtitle, domain.
# Frame, footer meta and format come from card(); watermarks are suppressed on
# framed cards by the renderer itself. Pick --scale so the text block clears the
# footer, then eyeball the PNG (satori has no auto-fit).
#
# After regenerating: copy out/site/<slug>.png to og-<slug>.png in the repo root,
# then run `pnpm cards:stamp` so each URL carries a hash of its new bytes. That
# stamp is what stops Telegram and X serving a card from months ago.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-out/site}"
mkdir -p "$OUT"
COUNT=0

# Shared template chrome. A card can still override any flag (last one wins),
# e.g. a different --meta for a card whose footer context isn't the house line.
card() {
  local name="$1"; shift
  "$HERE/node_modules/.bin/tsx" "$HERE/card.ts" hero \
    --format og --frame --meta "London / Lisbon" \
    --out "$OUT/$name.png" "$@" >/dev/null
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
echo "Wrote $COUNT cards to $OUT"
