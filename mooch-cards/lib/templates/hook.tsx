import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk } from '../layout'

interface Props {
  text: string
  eyebrow?: string
  swipe?: boolean
  size: { width: number; height: number }
  chrome?: Chrome
  scale?: number
}

// Opening card. Hero-sized serif, centred so big text fills the frame.

export function hook({ text, eyebrow, swipe = true, size, chrome, scale = 1 }: Props) {
  const align = eyebrow ? 'top' : 'center'
  return (
    <Card eyebrow={eyebrow} size={size} chrome={chrome} align={align} mark={text.trim().endsWith('?') ? '?' : undefined}>
      <Serif text={text} size={Math.round(brand.type.sizes.hero * scale)} leading={0.94} tracking="-0.025em" color={displayInk(chrome)} maxWidth="95%" />
    </Card>
  )
}
