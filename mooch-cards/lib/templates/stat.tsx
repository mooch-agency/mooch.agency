import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk, bodyInk, bodyMuted } from '../layout'

interface Props {
  number: string
  label: string
  footnote?: string
  eyebrow?: string
  trend?: 'up' | 'down'
  size: { width: number; height: number }
  chrome?: Chrome
}

export function stat({ number, label, footnote, eyebrow, trend, size, chrome }: Props) {
  const mark = trend === 'up' ? '↑' : trend === 'down' ? '↓' : undefined
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align="center" mark={mark}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <Serif text={number} size={Math.round(brand.type.sizes.display * 1.6)} leading={0.85} tracking="-0.03em" color={displayInk(chrome)} />
        <div style={{ display: 'flex', fontSize: brand.type.sizes.base, color: bodyInk(chrome), lineHeight: 1.25, maxWidth: size.width - brand.spacing.outer * 2 }}>
          {label}
        </div>
        {footnote ? (
          <div style={{ display: 'flex', fontSize: brand.type.sizes.caption, color: bodyMuted(chrome), marginTop: 8 }}>{footnote}</div>
        ) : null}
      </div>
    </Card>
  )
}
