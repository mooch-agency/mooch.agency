import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk, bodyMuted } from '../layout'

interface Props {
  term: string
  body: string
  eyebrow?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

// Dictionary-entry-as-poster. Term: massive serif. Body: sans.

export function definition({ term, body, eyebrow, size, chrome }: Props) {
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align="center" mark={term.trim().charAt(0).toUpperCase()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: '95%' }}>
        <Serif text={term} size={brand.type.sizes.display} leading={0.98} color={displayInk(chrome)} />
        <div style={{ display: 'flex', fontSize: brand.type.sizes.base, color: bodyMuted(chrome), lineHeight: 1.4 }}>{body}</div>
      </div>
    </Card>
  )
}
