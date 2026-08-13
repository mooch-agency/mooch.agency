# Fonts

Static TTFs Satori loads at render time (committed to the repo):

- `InstrumentSerif-Regular.ttf`, `InstrumentSerif-Italic.ttf` — display type
  (https://fonts.google.com/specimen/Instrument+Serif)
- `IBMPlexMono-Regular.ttf` — labels, eyebrows, wordmark
  (https://fonts.google.com/specimen/IBM+Plex+Mono)
- `Inter-Regular.ttf`, `Inter-Bold.ttf` — body copy
  (https://fonts.google.com/specimen/Inter)

Download the static TTFs from the family zip. Variable fonts often fail in
Satori with `Unsupported OpenType signature`.

## Swapping a font

1. Update the family name in `lib/brand.ts` (`serif`, `sans`, or `mono`)
2. Update the filename in `lib/render.ts` `loadFonts()`
3. Drop the new TTF in this folder
