import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk, bodyInk } from '../layout'

interface Props {
  prompt: string
  link: string
  eyebrow?: string
  size: { width: number; height: number }
  chrome?: Chrome
  scale?: number
}

// Outro slide. Serif prompt + mono link.

export function cta({ prompt, link, eyebrow, size, chrome, scale = 1 }: Props) {
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align="center" mark="→">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: '95%' }}>
        <Serif text={prompt} size={Math.round(brand.type.sizes.large * scale)} leading={1.02} color={displayInk(chrome)} />
        <div style={{ display: 'flex', fontFamily: brand.type.mono, fontSize: brand.type.sizes.small, letterSpacing: '0.04em', color: bodyInk(chrome) }}>
          {link}
        </div>
      </div>
    </Card>
  )
}
