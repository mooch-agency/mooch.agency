// One-off: render the "mooch" wordmark in Instrument Serif italic as outlined
// SVG paths (via Satori), tight-cropped to the glyphs. Black + white, transparent.
import fs from 'node:fs/promises'
import path from 'node:path'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const FONT_DIR = path.join(process.cwd(), 'fonts')
const OUT = path.join(process.cwd(), 'assets', 'wordmark')
const PAD_X = 58 // base horizontal breathing room
const PAD_Y = 24 // vertical breathing room above/below the glyphs
const LEFT_EXTRA = 48 // extra air before the M, on top of PAD_X

const italic = await fs.readFile(path.join(FONT_DIR, 'InstrumentSerif-Italic.ttf'))
const fonts = [{ name: 'Instrument Serif', data: italic, weight: 400, style: 'italic' }]

function el(color) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: 2400,
        height: 1000,
        alignItems: 'center',
        justifyContent: 'flex-start',
      },
      children: {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            fontFamily: 'Instrument Serif',
            fontStyle: 'italic',
            fontSize: 640,
            lineHeight: 1,
            letterSpacing: '-0.01em',
            color,
          },
          children: 'Mooch.',
        },
      },
    },
  }
}

// Crop the outer <svg> to the text bbox Satori emits in its content mask, with
// a little extra air before the M.
function crop(svg) {
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  let best = null
  for (const m of rects) {
    const [, x, y, w, h] = m.map(Number)
    if (w >= 2400) continue // skip the root canvas rect
    const area = w * h
    if (!best || area > best.area) best = { x, y, w, h, area }
  }
  const x = best.x - PAD_X - LEFT_EXTRA
  const y = best.y - PAD_Y
  const w = best.w + PAD_X * 2 + LEFT_EXTRA
  const h = best.h + PAD_Y * 2
  return svg
    .replace(/width="2400" height="1000"/, `width="${Math.round(w)}" height="${Math.round(h)}"`)
    .replace(/viewBox="[^"]*"/, `viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}"`)
}

await fs.mkdir(OUT, { recursive: true })

for (const [name, color] of [['black', '#000000'], ['white', '#ffffff']]) {
  const raw = await satori(el(color), { width: 2400, height: 1000, fonts })
  const svg = crop(raw)
  const svgPath = path.join(OUT, `mooch-italic-${name}-transparent.svg`)
  await fs.writeFile(svgPath, svg)
  // PNG with solid contrast bg (white text on black, black on white);
  // the -transparent.svg is the transparent variant.
  const bg = name === 'white' ? '#000000' : '#ffffff'
  const png = new Resvg(svg, { background: bg }).render().asPng()
  await fs.writeFile(path.join(OUT, `mooch-italic-${name}.png`), png)
  console.log('wrote', svgPath)
}
