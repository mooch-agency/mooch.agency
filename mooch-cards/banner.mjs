// LinkedIn banner (1584x396, 4:1) with the "Mooch." wordmark centred.
// Instrument Serif italic, glyphs outlined to paths via Satori. Two colourways.
import fs from 'node:fs/promises'
import path from 'node:path'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const FONT_DIR = path.join(process.cwd(), 'fonts')
const OUT = path.join(process.cwd(), 'assets', 'wordmark')
const W = 1584
const H = 396
const SIZE = 232 // wordmark font size; keeps generous margins on a 396-tall banner

const italic = await fs.readFile(path.join(FONT_DIR, 'InstrumentSerif-Italic.ttf'))
const fonts = [{ name: 'Instrument Serif', data: italic, weight: 400, style: 'italic' }]

function el(bg, fg) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: W,
        height: H,
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
      },
      children: {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            fontFamily: 'Instrument Serif',
            fontStyle: 'italic',
            fontSize: SIZE,
            lineHeight: 1,
            letterSpacing: '-0.01em',
            color: fg,
            // optical centring: nudge up a touch so the italic sits balanced
            paddingBottom: Math.round(SIZE * 0.12),
          },
          children: 'Mooch.',
        },
      },
    },
  }
}

await fs.mkdir(OUT, { recursive: true })

for (const [name, bg, fg] of [
  ['black-on-white', '#ffffff', '#000000'],
  ['white-on-black', '#000000', '#ffffff'],
]) {
  const svg = await satori(el(bg, fg), { width: W, height: H, fonts })
  const base = `mooch-banner-linkedin-${name}`
  await fs.writeFile(path.join(OUT, `${base}.svg`), svg)
  await fs.writeFile(path.join(OUT, `${base}.png`), new Resvg(svg).render().asPng())
  console.log('wrote', base)
}
