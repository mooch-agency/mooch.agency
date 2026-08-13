import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk } from '../layout'

interface Props {
  text: string
  author?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

export function quote({ text, author, size, chrome }: Props) {
  return (
    <Card byline={author} size={size} chrome={chrome} align="top" mark={'”'} markPlacement="br">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            display: 'flex',
            fontFamily: brand.type.serif,
            fontSize: 260,
            lineHeight: 1,
            height: 140,
            color: chrome?.dark ? '#3a3a3c' : brand.colors.hairline,
          }}
        >
          &ldquo;
        </div>
        <Serif text={text} size={brand.type.sizes.large} leading={1.08} color={displayInk(chrome)} />
      </div>
    </Card>
  )
}
