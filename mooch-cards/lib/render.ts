import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

// Resolved against this file, not the working directory, so the renderer works
// wherever it is called from, not only when standing in the repo root.
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts')

async function loadFonts() {
  try {
    const [serif, serifItalic, mono, regular, bold] = await Promise.all([
      fs.readFile(path.join(FONT_DIR, 'InstrumentSerif-Regular.ttf')),
      fs.readFile(path.join(FONT_DIR, 'InstrumentSerif-Italic.ttf')),
      fs.readFile(path.join(FONT_DIR, 'IBMPlexMono-Regular.ttf')),
      fs.readFile(path.join(FONT_DIR, 'Inter-Regular.ttf')),
      fs.readFile(path.join(FONT_DIR, 'Inter-Bold.ttf')),
    ])
    return [
      // Display face, roman + italic. Emphasis is the italic mixed in per word.
      { name: 'Instrument Serif', data: serif, weight: 400 as const, style: 'normal' as const },
      { name: 'Instrument Serif', data: serifItalic, weight: 400 as const, style: 'italic' as const },
      // Mono for labels/eyebrows/wordmark (stands in for the site's system mono).
      { name: 'IBM Plex Mono', data: mono, weight: 400 as const, style: 'normal' as const },
      // Body sans (stands in for the site's system sans).
      { name: 'Inter', data: regular, weight: 400 as const, style: 'normal' as const },
      { name: 'Inter', data: bold, weight: 700 as const, style: 'normal' as const },
    ]
  } catch {
    throw new Error(
      `Couldn't load fonts. Expected InstrumentSerif-Regular.ttf, ` +
        `InstrumentSerif-Italic.ttf, IBMPlexMono-Regular.ttf, Inter-Regular.ttf ` +
        `and Inter-Bold.ttf in ${FONT_DIR}.`
    )
  }
}

export async function renderCard(
  element: any,
  size: { width: number; height: number }
): Promise<Buffer> {
  const fonts = await loadFonts()
  const svg = await satori(element, {
    width: size.width,
    height: size.height,
    fonts,
  })
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size.width },
  })
  return resvg.render().asPng()
}
