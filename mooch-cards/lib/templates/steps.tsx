import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk, bodyInk, bodyMuted } from '../layout'

interface Props {
  steps: string[]
  eyebrow?: string
  title?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

// Numbered list. Order is the point. Numbers set in the serif.

export function steps({ steps, eyebrow, title, size, chrome }: Props) {
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align="center" mark={String(steps.length)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 40, width: '100%' }}>
        {title ? <Serif text={title} size={brand.type.sizes.large} leading={1.0} color={displayInk(chrome)} /> : null}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {steps.map((s, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'row',
                gap: 32,
                alignItems: 'baseline',
                padding: '22px 0',
                borderTop: `1px solid ${chrome?.dark ? '#2a2a2c' : brand.colors.hairline}`,
              }}
            >
              <div style={{ display: 'flex', fontFamily: brand.type.serif, fontSize: brand.type.sizes.large, color: bodyMuted(chrome), width: 96, flexShrink: 0 }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div style={{ display: 'flex', fontSize: brand.type.sizes.base, color: bodyInk(chrome), lineHeight: 1.3, flex: 1 }}>{s}</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
