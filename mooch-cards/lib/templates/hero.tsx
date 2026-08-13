import { brand } from '../brand'
import { Serif, splitLines } from '../type'
import { Card, Chrome, displayInk, bodyMuted } from '../layout'

interface Props {
  title: string
  subtitle?: string
  eyebrow?: string
  size: { width: number; height: number }
  chrome?: Chrome
  scale?: number
  align?: 'top' | 'center'
}

export function hero({ title, subtitle, eyebrow, size, chrome, scale = 1, align = 'top' }: Props) {
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align={align}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32, maxWidth: '92%' }}>
        <Serif text={title} size={Math.round(brand.type.sizes.hero * scale)} leading={0.94} tracking="-0.025em" color={displayInk(chrome)} />
        {subtitle ? (
          // "\n" forces a line break (see splitLines), for when the break
          // position matters. A blank line keeps its height via an nbsp.
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: brand.type.sizes.base, lineHeight: 1.4, color: bodyMuted(chrome), maxWidth: '85%' }}>
            {splitLines(subtitle).map((line, i) => (
              <div key={i} style={{ display: 'flex' }}>{line.trim() === '' ? ' ' : line}</div>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
