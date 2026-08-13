import { brand } from './brand'

// Split "one *word* italic" into word tokens, flagging which sit inside *...*.
function toWords(text: string) {
  const runs: { t: string; em: boolean }[] = []
  let em = false
  for (const part of text.split('*')) {
    if (part) runs.push({ t: part, em })
    em = !em
  }
  const words: { w: string; em: boolean }[] = []
  for (const r of runs) {
    for (const tok of r.t.split(/(\s+)/)) {
      if (tok.trim() === '') continue
      // A punctuation-only token (e.g. the "." left outside *emphasis*) can't be
      // pulled back across a line wrap, so it orphans onto its own line. Glue it
      // onto the preceding word instead, keeping that word's style.
      if (PUNCT.test(tok) && words.length) {
        words[words.length - 1].w += tok
      } else {
        words.push({ w: tok, em: r.em })
      }
    }
  }
  return words
}

const PUNCT = /^[.,;:!?)]+$/

// "\n" forces a line break: a literal backslash-n as typed in the shell, or a
// real newline. The one split rule for every card text (titles and subtitles),
// so the escape convention can't drift between components.
export const splitLines = (text: string) => text.split(/\\n|\n/)

interface SerifProps {
  text: string
  size: number
  color?: string
  leading?: number
  tracking?: string
  maxWidth?: string | number
  center?: boolean
  italic?: boolean // render the whole line italic (asterisks still work too)
}

// Display type in Instrument Serif. Words wrapped in *asterisks* render italic,
// the site's emphasis move. Laid out as word spans so the italic can sit
// mid-line and the phrase still wraps; trailing punctuation hugs its word.
export function Serif({
  text,
  size,
  color = brand.colors.black,
  leading = brand.type.displayLeading,
  tracking = brand.type.displayTracking,
  maxWidth,
  center,
  italic,
}: SerifProps) {
  const space = size * 0.2
  // Each forced line is its own wrapping row, so natural wrap still works
  // within a line. An *emphasis* span may cross a break: carry the italic state
  // over by re-opening it on the next line (asterisks toggle, so parity is the
  // state). A blank line renders as a spacer row, not a zero-height div.
  let emOpen = false
  const lines = splitLines(text).map(raw => {
    const line = emOpen ? '*' + raw : raw
    emOpen = (line.match(/\*/g) ?? []).length % 2 === 1
    return line
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxWidth: maxWidth ?? '100%' }}>
      {lines.map((line, li) =>
        toWords(line).length === 0 ? (
          <div key={li} style={{ display: 'flex', height: Math.round(size * leading) }} />
        ) : (
    <div
      key={li}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: center ? 'center' : 'flex-start',
        fontFamily: brand.type.serif,
        fontSize: size,
        color,
        letterSpacing: tracking,
      }}
    >
      {toWords(line).map((wd, i) => {
        // A word that already ends in punctuation carries its own trailing
        // sidebearing, so trim the added space or the gap reads as double.
        const endsPunct = /[.,;:!?]$/.test(wd.w)
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              fontStyle: italic || wd.em ? 'italic' : 'normal',
              lineHeight: leading,
              marginRight: PUNCT.test(wd.w) ? space : endsPunct ? size * 0.1 : space,
              // Pull a lone punctuation token back so it hugs the preceding word.
              marginLeft: PUNCT.test(wd.w) ? -space : 0,
            }}
          >
            {wd.w}
          </div>
        )
      })}
    </div>
        )
      )}
    </div>
  )
}

interface LabelProps {
  text: string
  size?: number
  color?: string
}

// Mono eyebrow / label: tiny, uppercase, wide-tracked. The site's label texture.
export function Label({ text, size = brand.type.sizes.label, color = brand.colors.muted }: LabelProps) {
  return (
    <div
      style={{
        display: 'flex',
        fontFamily: brand.type.mono,
        fontSize: size,
        textTransform: 'uppercase',
        letterSpacing: '0.16em',
        color,
      }}
    >
      {text}
    </div>
  )
}

// Wordmark / URL in mono, lightly tracked, not uppercased (reads as a domain).
export function Wordmark({ color = brand.colors.muted }: { color?: string } = {}) {
  return (
    <div
      style={{
        display: 'flex',
        fontFamily: brand.type.mono,
        fontSize: brand.type.sizes.label,
        letterSpacing: '0.06em',
        color,
      }}
    >
      mooch.agency
    </div>
  )
}
