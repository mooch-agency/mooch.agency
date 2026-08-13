import { brand } from './brand'

// Circular avatar. Renders the image (grayscale, to stay monochrome) when a
// data URI is given, otherwise a neutral placeholder ring with an initial.
export function Avatar({ src, initial, d, dark }: { src?: string; initial?: string; d: number; dark?: boolean }) {
  const ring = dark ? '#2a2a2c' : brand.colors.hairline
  if (src) {
    // Light fill so a transparent PNG with dark linework reads on any card colour.
    return (
      <div style={{ display: 'flex', width: d, height: d, borderRadius: d, overflow: 'hidden', background: brand.colors.paper, border: `1px solid ${ring}` }}>
        <img src={src} width={d} height={d} style={{ objectFit: 'cover', filter: 'grayscale(1)' }} />
      </div>
    )
  }
  const bg = dark ? '#161616' : '#f0f0f2'
  const fg = dark ? brand.colors.mutedDark : brand.colors.muted
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: d, height: d, borderRadius: d, background: bg, border: `1px solid ${ring}` }}>
      {initial ? <div style={{ display: 'flex', fontFamily: brand.type.serif, fontSize: Math.round(d * 0.42), color: fg }}>{initial}</div> : null}
    </div>
  )
}
