import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, bodyInk, bodyMuted } from '../layout'

interface Props {
  leftTitle: string
  leftBody?: string
  rightTitle: string
  rightBody?: string
  eyebrow?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

// 2 columns, hairline divider between. Left muted (setup), right ink (answer).

export function sideBySide({ leftTitle, leftBody, rightTitle, rightBody, eyebrow, size, chrome }: Props) {
  // Row is: col + gap(48) + divider(1) + gap(48) + col, inside the padded box.
  // A framed card loses 2px more to the hairline borders (1px each side).
  const colWidth = Math.floor((size.width - brand.spacing.outer * 2 - (chrome?.frame ? 2 : 0) - 97) / 2)
  const answerInk = chrome?.dark ? brand.colors.paper : brand.colors.black

  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align="center">
      <div style={{ display: 'flex', flexDirection: 'row', gap: 48, width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: colWidth, gap: 16 }}>
          <Serif text={leftTitle} size={brand.type.sizes.large} color={bodyMuted(chrome)} leading={1.0} />
          {leftBody ? (
            <div style={{ display: 'flex', fontSize: brand.type.sizes.small, color: bodyMuted(chrome), lineHeight: 1.4 }}>{leftBody}</div>
          ) : null}
        </div>

        <div style={{ display: 'flex', width: 1, background: chrome?.dark ? '#2a2a2c' : brand.colors.hairline, alignSelf: 'stretch' }} />

        <div style={{ display: 'flex', flexDirection: 'column', width: colWidth, gap: 16 }}>
          <Serif text={rightTitle} size={brand.type.sizes.large} color={answerInk} leading={1.0} />
          {rightBody ? (
            <div style={{ display: 'flex', fontSize: brand.type.sizes.small, color: bodyInk(chrome), lineHeight: 1.4 }}>{rightBody}</div>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
