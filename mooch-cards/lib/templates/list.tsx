import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk, bodyInk } from '../layout'

interface Props {
  bullets: string[]
  eyebrow?: string
  title?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

export function list({ bullets, eyebrow, title, size, chrome }: Props) {
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align="center" mark={String(bullets.length)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 40, width: '100%' }}>
        {title ? <Serif text={title} size={brand.type.sizes.large} leading={1.0} color={displayInk(chrome)} /> : null}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {bullets.map((b, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'row',
                gap: 28,
                alignItems: 'flex-start',
                padding: '24px 0',
                borderTop: `1px solid ${chrome?.dark ? '#2a2a2c' : brand.colors.hairline}`,
              }}
            >
              <div style={{ display: 'flex', width: 10, height: 10, marginTop: 18, flexShrink: 0, background: chrome?.dark ? brand.colors.paper : brand.colors.ink }} />
              <div style={{ display: 'flex', fontSize: brand.type.sizes.base, color: bodyInk(chrome), lineHeight: 1.3, flex: 1 }}>{b}</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
