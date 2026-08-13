// Instagram 1080x1080: the "fastest model" comparison as ONE screenshot card
// (two stacked sections + connecting arrow) framed on the kit's paper, with an
// Instrument Serif caption above. Monochrome kit style + one red accent.
import fs from 'node:fs/promises'
import path from 'node:path'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const FONT_DIR = path.join(process.cwd(), 'fonts')
const OUT = process.argv[2] || path.join(process.cwd(), 'out', 'posts', 'slowhorse.png')
const S = 1080

const C = {
  paper: '#ffffff', warm: '#efeee8', ink: '#1d1d1f', black: '#000000',
  muted: '#6e6e73', faint: '#9a9a9f', hairline: '#ededea', track: '#e9e8e3',
  red: '#b5392e', pillBg: '#f4dcd8',
}

const [serif, serifI, mono, sans] = await Promise.all([
  fs.readFile(path.join(FONT_DIR, 'InstrumentSerif-Regular.ttf')),
  fs.readFile(path.join(FONT_DIR, 'InstrumentSerif-Italic.ttf')),
  fs.readFile(path.join(FONT_DIR, 'IBMPlexMono-Regular.ttf')),
  fs.readFile(path.join(FONT_DIR, 'Inter-Regular.ttf')),
])
const fonts = [
  { name: 'Instrument Serif', data: serif, weight: 400, style: 'normal' },
  { name: 'Instrument Serif', data: serifI, weight: 400, style: 'italic' },
  { name: 'IBM Plex Mono', data: mono, weight: 400, style: 'normal' },
  { name: 'Inter', data: sans, weight: 400, style: 'normal' },
]

const div = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } })
const txt = (s, style) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children: s } })

// Fixed-height row: the name / bar / value align on one line, and any sub-label
// or pill sits in reserved space below — so bar-to-bar spacing is identical in
// every row of both sections.
// Fixed-height row: name / bar / value are vertically centred; any sub-label or
// pill is floated just beneath the name (absolute, out of flow) so it never
// shifts the bar off-centre. Bar-to-bar spacing stays identical across rows.
function row(name, sub, fill, value, opts = {}) {
  const barColor = opts.red ? C.red : C.black
  const floats = []
  if (sub) floats.push(txt(sub, { position: 'absolute', top: 34, left: 0, fontFamily: 'IBM Plex Mono', fontSize: 15, letterSpacing: '0.11em', color: opts.red ? C.red : C.muted }))
  if (opts.pill) floats.push(div({ position: 'absolute', top: 34, left: 0, background: C.pillBg, borderRadius: 999, padding: '6px 15px' },
    txt(opts.pill, { fontFamily: 'IBM Plex Mono', fontSize: 14, letterSpacing: '0.11em', color: C.red })))
  return div({ flexDirection: 'row', alignItems: 'center', gap: 24, height: 84 }, [
    div({ position: 'relative', width: 230, alignItems: 'center' }, [
      txt(name, { fontFamily: 'Inter', fontSize: 27, color: C.ink }),
      ...floats,
    ]),
    div({ flex: 1, height: 11, background: C.track, borderRadius: 999 },
      div({ width: `${Math.round(fill * 100)}%`, height: 11, background: barColor, borderRadius: 999 })),
    txt(value, { fontFamily: 'IBM Plex Mono', fontSize: 25, color: C.ink, width: 74, justifyContent: 'flex-end' }),
  ])
}

function section(head, headRight, rows) {
  const stacked = []
  rows.forEach((r, i) => {
    if (i > 0) stacked.push(div({ height: 1, background: C.hairline }, ''))
    stacked.push(r)
  })
  return div({ flexDirection: 'column' }, [
    div({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }, [
      txt(head, { fontFamily: 'IBM Plex Mono', fontSize: 19, letterSpacing: '0.16em', color: C.ink }),
      txt(headRight, { fontFamily: 'IBM Plex Mono', fontSize: 19, letterSpacing: '0.16em', color: C.faint }),
    ]),
    div({ height: 2, background: C.ink, marginTop: 16, marginBottom: 10 }, ''),
    div({ flexDirection: 'column' }, stacked),
  ])
}

const screenshot = div(
  { flexDirection: 'column', background: C.paper, borderRadius: 26, padding: '40px 44px', boxShadow: '0 8px 26px rgba(0,0,0,0.07)' },
  [
    section('ALL FINDINGS', 'RAW COUNT', [
      row('GPT-5.6 Luna', 'FASTEST', 0.94, '1st'),
      row('Sonnet 5', null, 0.72, '2nd'),
      row('Opus 4.8', null, 0.54, '3rd'),
    ]),
    div({ justifyContent: 'center', marginTop: 22, marginBottom: 22 },
      txt('↓', { fontFamily: 'Inter', fontSize: 34, color: C.muted })),
    section('HIGH + CRITICAL ONLY', 'RECALL', (() => {
      const r = {
        opus: row('Opus 4.8', '0 HALLUCINATIONS', 0.72, '0.60'),
        sonnet: row('Sonnet 5', null, 0.63, '0.53'),
        gpt: row('GPT-5.6 Luna', null, 0.56, '0.47', { red: true, pill: 'FABRICATED A FINDING' }),
      }
      // Default keeps the panel-1 order (GPT, Sonnet, Opus) so each model stays on
      // its own row and its reversal is trackable; pass 'sorted' to re-rank
      // best-to-worst by recall instead.
      return process.argv[3] === 'sorted' ? [r.opus, r.sonnet, r.gpt] : [r.gpt, r.sonnet, r.opus]
    })()),
  ]
)

const tree = div(
  { width: S, height: S, background: C.warm, flexDirection: 'column', padding: '70px 66px', justifyContent: 'center', gap: 52 },
  [
    div({ flexDirection: 'column' }, [
      txt('The fastest model won.', { fontFamily: 'Instrument Serif', fontSize: 70, lineHeight: 1.02, color: C.black }),
      txt('Until we read what it found.', { fontFamily: 'Instrument Serif', fontStyle: 'italic', fontSize: 70, lineHeight: 1.02, color: C.black }),
    ]),
    screenshot,
  ]
)

const svg = await satori(tree, { width: S, height: S, fonts })
await fs.mkdir(path.dirname(OUT), { recursive: true })
await fs.writeFile(OUT, new Resvg(svg, { fitTo: { mode: 'width', value: S } }).render().asPng())
console.log('wrote', OUT)
