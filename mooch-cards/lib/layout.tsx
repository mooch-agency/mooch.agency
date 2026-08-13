import { brand } from './brand'

// Faint category tints, lifted from the homepage bento cards (tokens.css --cat-*).
export const TINT = {
  product: 'hsl(220, 30%, 94%)',
  prompt: 'hsl(270, 30%, 94%)',
  plaything: 'hsl(35, 40%, 93%)',
  ai: 'hsl(200, 30%, 94%)',
} as const

const RULE_DARK = '#2a2a2c'

// The site's share-card house style (og.jpg, og-image.png, og-paulgraham.png):
// a hairline rounded frame inset from the edge, and a footer that runs context
// on the left against the domain on the right. FRAME_INSET + FRAME_PAD sum to
// brand.spacing.outer so framed and unframed cards share one content margin.
const FRAME_INSET = 24
const FRAME_PAD = brand.spacing.outer - FRAME_INSET
const FRAME_RADIUS = 18

// Carousel / styling context shared by every template. Index + total light up the
// corner index, the footer page counter and the watermark numeral. dark and tint
// are opt-in accents.
export interface Chrome {
  index?: number
  total?: number
  dark?: boolean
  tint?: keyof typeof TINT
  watermark?: boolean // defaults on when the template supplies a mark
  mark?: string // overrides the template's own relevant watermark glyph
  footer?: boolean // set false to drop the footer entirely (rule + wordmark)
  frame?: boolean // hairline rounded frame, the share-card house style
  meta?: string // footer-left context ("london / lisbon", "208 essays · 25 years")
  domain?: string // footer-right domain; switches the footer to the OG two-column form
}

const pad = (n: number) => String(n).padStart(2, '0')

// Colour helpers so display/body pick the right ink for light, tint or dark.
export const displayInk = (c?: Chrome) => (c?.dark ? brand.colors.paper : brand.colors.black)
export const bodyInk = (c?: Chrome) => (c?.dark ? brand.colors.paper : brand.colors.ink)
export const bodyMuted = (c?: Chrome) => (c?.dark ? brand.colors.mutedDark : brand.colors.muted)

const monoStyle = (color: string, tracking = '0.16em', upper = true): any => ({
  display: 'flex',
  fontFamily: brand.type.mono,
  fontSize: brand.type.sizes.label,
  letterSpacing: tracking,
  color,
  ...(upper ? { textTransform: 'uppercase' } : {}),
})

// Mono eyebrow with the site's leading ink tick (.hero-eyebrow::before).
// A long eyebrow wraps within maxWidth instead of bleeding off the card.
function EyebrowRow({ text, dark, maxWidth }: { text: string; dark?: boolean; maxWidth?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18 }}>
      <div style={{ display: 'flex', width: 52, height: 2, marginTop: 8, background: dark ? brand.colors.paper : brand.colors.ink }} />
      <div style={{ ...monoStyle(dark ? brand.colors.mutedDark : brand.colors.muted), lineHeight: 1.4, maxWidth }}>{text}</div>
    </div>
  )
}

function Header({ eyebrow, index, total, dark, maxWidth }: { eyebrow?: string; index?: number; total?: number; dark?: boolean; maxWidth?: number }) {
  const c = dark ? brand.colors.mutedDark : brand.colors.muted
  const idxLabel = index ? (total ? `N° ${pad(index)} / ${pad(total)}` : `N° ${pad(index)}`) : null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
      {eyebrow ? <EyebrowRow text={eyebrow} dark={dark} maxWidth={maxWidth} /> : <div style={{ display: 'flex' }} />}
      {idxLabel ? <div style={monoStyle(c)}>{idxLabel}</div> : null}
    </div>
  )
}

function Footer({ index, total, dark, byline, meta, domain }: { index?: number; total?: number; dark?: boolean; byline?: string; meta?: string; domain?: string }) {
  const muted = dark ? brand.colors.mutedDark : brand.colors.muted
  const ink = bodyInk({ dark })
  const line = dark ? RULE_DARK : brand.colors.hairline
  const counter = index ? (total ? `${pad(index)} / ${pad(total)}` : pad(index)) : null

  // Left: whichever context exists — share-card meta, then the quote author,
  // then the house default. Right: the domain when set (the OG signature, in
  // full ink), else the wordmark or the carousel counter. Nothing passed in is
  // ever silently dropped in favour of a default.
  const left = meta ?? byline ?? 'mooch.agency'
  const right = domain ?? (byline ? 'mooch.agency' : counter)
  const leftStyle = meta ? monoStyle(muted) : byline ? monoStyle(ink) : monoStyle(muted, '0.06em', false)
  const rightStyle = domain ? monoStyle(ink) : byline ? monoStyle(muted, '0.06em', false) : monoStyle(muted)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, width: '100%' }}>
      <div style={{ display: 'flex', height: 1, background: line, width: '100%' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
        <div style={leftStyle}>{left}</div>
        {right ? <div style={rightStyle}>{right}</div> : null}
      </div>
    </div>
  )
}

// Faint oversized mark, top-right. Content-relevant per template (a term's
// initial, an item count, a "?" or "→"), never a generic decoration.
function Watermark({
  mark,
  dark,
  tint,
  size,
  placement = 'tr',
}: {
  mark: string
  dark?: boolean
  tint?: boolean
  size: { width: number; height: number }
  placement?: 'tr' | 'br'
}) {
  const color = dark ? '#1c1c1c' : tint ? 'rgba(0,0,0,0.055)' : '#eeeef0'
  const isArrow = /[→←↑↓↗↘]/.test(mark)
  const edge = Math.round(size.width * 0.03)
  const pos = placement === 'br' ? { bottom: Math.round(size.height * 0.08), right: edge } : { top: Math.round(size.height * 0.02), right: edge }
  return (
    <div
      style={{
        position: 'absolute',
        ...pos,
        display: 'flex',
        fontFamily: isArrow ? brand.type.sans : brand.type.serif,
        fontSize: Math.round(size.height * (isArrow ? 0.34 : 0.42)),
        lineHeight: 1,
        color,
      }}
    >
      {mark}
    </div>
  )
}

interface CardProps {
  eyebrow?: string
  byline?: string
  size: { width: number; height: number }
  chrome?: Chrome
  align?: 'top' | 'center'
  mark?: string // template's content-relevant watermark glyph
  markPlacement?: 'tr' | 'br'
  header?: any // custom top zone, overrides the default eyebrow header
  children: any
}

// Shared card scaffold: tick eyebrow + corner index, hairline footer with wordmark
// and page counter, optional index-numeral watermark. Every template renders
// through this so the chrome can't drift.
export function Card({ eyebrow, byline, size, chrome = {}, align = 'center', mark, markPlacement = 'tr', header: headerOverride, children }: CardProps) {
  const { index, total, dark, tint, frame } = chrome
  const activeMark = chrome.mark ?? mark
  // Framed cards never show a watermark: the frame doesn't clip its contents
  // (overflow:hidden + borderRadius panics resvg), and the mark's offsets are
  // sized against the full card, so it would bleed across the hairline. Enforced
  // here rather than asking every caller to remember --no-watermark.
  const showWatermark = (chrome.watermark ?? true) && !!activeMark && !chrome.frame
  const hasHeader = !!eyebrow || !!index
  const bg = dark ? brand.colors.black : tint ? TINT[tint] : brand.colors.bg
  // Wrap a long eyebrow within the content box (leave room for a corner index).
  const contentW = size.width - brand.spacing.outer * 2
  const eyebrowMax = index ? contentW - 260 : contentW - 70
  const header = headerOverride ?? (hasHeader ? <Header eyebrow={eyebrow} index={index} total={total} dark={dark} maxWidth={eyebrowMax} /> : null)
  const footer = chrome.footer === false ? null : <Footer index={index} total={total} dark={dark} byline={byline} meta={chrome.meta} domain={chrome.domain} />

  // An array, not a fragment: Satori does not flatten fragments into the parent
  // flex container, so wrapping these in <>...</> lays the footer out as a row
  // sibling instead of the last column child.
  const body = [
    showWatermark ? <Watermark key="watermark" mark={activeMark!} dark={dark} tint={!!tint} size={size} placement={markPlacement} /> : null,

    align === 'top' ? (
      <div key="content" style={{ display: 'flex', flexDirection: 'column', gap: 64, width: '100%' }}>
        {header}
        {children}
      </div>
    ) : (
      <div key="content" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, width: '100%' }}>
        {header}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1, width: '100%' }}>
          {children}
        </div>
      </div>
    ),

    footer ? <div key="footer" style={{ display: 'flex', width: '100%' }}>{footer}</div> : null,
  ]

  const stack: any = {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: align === 'top' ? 'space-between' : 'flex-start',
    ...(showWatermark ? { position: 'relative' } : {}),
    fontFamily: brand.type.sans,
  }

  // Unframed: one box carries the ground, the margin and the content.
  if (!frame) {
    return <div style={{ ...stack, width: size.width, height: size.height, padding: brand.spacing.outer, background: bg }}>{body}</div>
  }

  // Framed: the ground sits on the outer box, the hairline rule and the rest of
  // the content margin on the inner one.
  // No `overflow: hidden` here: paired with borderRadius it panics resvg
  // ("called `Option::unwrap()` on a `None` value") once the footer has content.
  // Watermarks are suppressed for framed cards where showWatermark is computed.
  return (
    <div style={{ display: 'flex', width: size.width, height: size.height, padding: FRAME_INSET, background: bg }}>
      <div
        style={{
          ...stack,
          flexGrow: 1,
          padding: FRAME_PAD,
          border: `1px solid ${dark ? RULE_DARK : brand.colors.hairline}`,
          borderRadius: FRAME_RADIUS,
        }}
      >
        {body}
      </div>
    </div>
  )
}
