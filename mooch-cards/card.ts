#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { renderCard } from './lib/render'
import { Chrome, TINT } from './lib/layout'
import { quote } from './lib/templates/quote'
import { stat } from './lib/templates/stat'
import { sideBySide } from './lib/templates/side-by-side'
import { hero } from './lib/templates/hero'
import { list } from './lib/templates/list'
import { definition } from './lib/templates/definition'
import { hook } from './lib/templates/hook'
import { cta } from './lib/templates/cta'
import { steps } from './lib/templates/steps'
import { portfolio } from './lib/templates/portfolio'
import { teamCover } from './lib/templates/team-cover'
import { teamMember } from './lib/templates/team-member'

type Format = 'square' | 'portrait' | 'substack' | 'og'

const FORMATS: Record<Format, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },   // 1:1, default, cross-platform safe
  portrait: { width: 1080, height: 1350 }, // 4:5, max LinkedIn impressions
  substack: { width: 1456, height: 816 },  // Substack hero, post inline
  og: { width: 1200, height: 630 },        // Twitter, default OG
}

interface Args {
  _: string[]
  format?: Format
  out?: string
  // chrome (carousel + styling context)
  index?: string
  total?: string
  dark?: boolean | string
  tint?: string
  mark?: string
  scale?: string
  align?: string
  'no-watermark'?: boolean | string
  'no-footer'?: boolean | string
  frame?: boolean | string
  meta?: string
  domain?: string
  // shared
  eyebrow?: string
  title?: string
  text?: string
  // portfolio
  name?: string
  work?: string
  // team
  role?: string
  line?: string
  avatar?: string
  avatar1?: string
  avatar2?: string
  avatar3?: string
  // quote
  author?: string
  // stat
  number?: string
  label?: string
  footnote?: string
  trend?: string
  // side-by-side
  'left-title'?: string
  'left-body'?: string
  'right-title'?: string
  'right-body'?: string
  // hero
  subtitle?: string
  // list
  bullet1?: string
  bullet2?: string
  bullet3?: string
  bullet4?: string
  bullet5?: string
  // definition
  term?: string
  body?: string
  // hook
  'no-swipe'?: boolean | string
  // cta
  prompt?: string
  link?: string
  // steps
  step1?: string
  step2?: string
  step3?: string
  step4?: string
  step5?: string
}

function parseArgs(argv: string[]): Args {
  const result: any = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        result[key] = true
      } else {
        result[key] = next
        i++
      }
    } else {
      result._.push(a)
    }
  }
  return result
}

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

// Read an image into a base64 data URI for embedding in Satori. Returns
// undefined (and warns) when the file is missing, so templates fall back to a
// placeholder rather than crashing.
async function imgDataUri(p?: string): Promise<string | undefined> {
  if (!p) return undefined
  try {
    const b = await fs.readFile(p)
    const ext = path.extname(p).slice(1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${b.toString('base64')}`
  } catch {
    console.error(`avatar not found: ${p} — rendering a placeholder`)
    return undefined
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const template = args._[0]
  const format = (args.format ?? 'square') as Format
  const size = FORMATS[format]

  if (!size) {
    die(`Unknown format: ${format}. Use square, portrait, substack, or og.`)
  }

  if (args.tint && !(args.tint in TINT)) {
    die(`Unknown tint: ${args.tint}. Use ${Object.keys(TINT).join(', ')}.`)
  }

  const chrome: Chrome = {
    index: args.index ? parseInt(args.index, 10) : undefined,
    total: args.total ? parseInt(args.total, 10) : undefined,
    dark: !!args.dark,
    tint: args.tint as Chrome['tint'],
    mark: typeof args.mark === 'string' ? args.mark : undefined,
    watermark: args['no-watermark'] ? false : undefined,
    footer: args['no-footer'] ? false : undefined,
    // "--frame false" parses as the string "false"; don't let it read as true.
    frame: args.frame === 'false' ? false : !!args.frame,
    meta: typeof args.meta === 'string' ? args.meta : undefined,
    domain: typeof args.domain === 'string' ? args.domain : undefined,
  }

  const scale = args.scale ? parseFloat(args.scale) : 1

  let element: any

  switch (template) {
    case 'quote':
      if (!args.text) {
        die('quote requires --text "..." (--author optional)')
      }
      element = quote({ text: args.text!, author: args.author, size, chrome })
      break

    case 'stat':
      if (!args.number || !args.label) {
        die('stat requires --number "..." --label "..."')
      }
      element = stat({
        number: args.number!,
        label: args.label!,
        footnote: args.footnote,
        eyebrow: args.eyebrow,
        trend: args.trend === 'up' || args.trend === 'down' ? args.trend : undefined,
        size,
        chrome,
      })
      break

    case 'side-by-side':
      if (!args['left-title'] || !args['right-title']) {
        die('side-by-side requires --left-title "..." --right-title "..."')
      }
      element = sideBySide({
        leftTitle: args['left-title']!,
        leftBody: args['left-body'],
        rightTitle: args['right-title']!,
        rightBody: args['right-body'],
        eyebrow: args.eyebrow,
        size,
        chrome,
      })
      break

    case 'hero':
      if (!args.title) die('hero requires --title "..."')
      element = hero({
        title: args.title!,
        subtitle: args.subtitle,
        eyebrow: args.eyebrow,
        size,
        chrome,
        scale,
        align: args.align === 'center' ? 'center' : 'top',
      })
      break

    case 'list': {
      const bullets = [
        args.bullet1,
        args.bullet2,
        args.bullet3,
        args.bullet4,
        args.bullet5,
      ].filter(Boolean) as string[]
      if (bullets.length === 0) {
        die('list requires at least --bullet1 "..." (up to --bullet5)')
      }
      element = list({
        bullets,
        eyebrow: args.eyebrow,
        title: args.title,
        size,
        chrome,
      })
      break
    }

    case 'definition':
      if (!args.term || !args.body) {
        die('definition requires --term "..." --body "..."')
      }
      element = definition({
        term: args.term!,
        body: args.body!,
        eyebrow: args.eyebrow,
        size,
        chrome,
      })
      break

    case 'hook':
      if (!args.text) die('hook requires --text "..."')
      element = hook({
        text: args.text!,
        eyebrow: args.eyebrow,
        swipe: !args['no-swipe'],
        size,
        chrome,
        scale,
      })
      break

    case 'cta':
      if (!args.prompt || !args.link) {
        die('cta requires --prompt "..." --link "..."')
      }
      element = cta({
        prompt: args.prompt!,
        link: args.link!,
        eyebrow: args.eyebrow,
        size,
        chrome,
        scale,
      })
      break

    case 'steps': {
      const stepArr = [
        args.step1,
        args.step2,
        args.step3,
        args.step4,
        args.step5,
      ].filter(Boolean) as string[]
      if (stepArr.length === 0) {
        die('steps requires at least --step1 "..." (up to --step5)')
      }
      element = steps({
        steps: stepArr,
        eyebrow: args.eyebrow,
        title: args.title,
        size,
        chrome,
      })
      break
    }

    case 'portfolio':
      if (!args.name || !args.work) {
        die('portfolio requires --name "..." --work "..."')
      }
      element = portfolio({ name: args.name!, work: args.work!, size, chrome, scale })
      break

    case 'team-cover': {
      if (!args.line) die('team-cover requires --line "..." (and --avatar1/2/3)')
      const avatars = await Promise.all([imgDataUri(args.avatar1), imgDataUri(args.avatar2), imgDataUri(args.avatar3)])
      element = teamCover({ avatars, line: args.line!, eyebrow: args.eyebrow, size, chrome })
      break
    }

    case 'team-member': {
      if (!args.name || !args.role) die('team-member requires --name "..." --role "..." (and --avatar)')
      const avatar = await imgDataUri(args.avatar)
      element = teamMember({ name: args.name!, role: args.role!, avatar, eyebrow: args.eyebrow, size, chrome })
      break
    }

    default:
      die(
        `Unknown template: ${template ?? '(missing)'}. ` +
          `Use 'quote', 'stat', 'side-by-side', 'hero', 'list', 'definition', 'hook', 'cta', 'steps', 'portfolio', 'team-cover', or 'team-member'.`
      )
  }

  const png = await renderCard(element, size)
  const outPath = args.out ?? path.join('out', `${template}-${format}-${Date.now()}.png`)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, png)
  console.log(`Wrote ${outPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
