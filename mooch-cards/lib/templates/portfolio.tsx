import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk } from '../layout'

interface Props {
  name: string
  work: string
  size: { width: number; height: number }
  chrome?: Chrome
  scale?: number
}

// Portfolio / case-study card: client name up top (ink, real casing, tick-led),
// the work as the bold serif statement. Client is clear, statement carries.
export function portfolio({ name, work, size, chrome, scale = 1 }: Props) {
  const dark = chrome?.dark
  const nameColor = dark ? brand.colors.paper : brand.colors.ink
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <div style={{ display: 'flex', width: 52, height: 2, background: nameColor }} />
      <div style={{ display: 'flex', fontFamily: brand.type.mono, fontSize: 34, letterSpacing: '0.02em', color: nameColor }}>{name}</div>
    </div>
  )
  return (
    <Card size={size} chrome={chrome} align="center" header={header}>
      <Serif text={work} size={Math.round(76 * scale)} leading={1.03} tracking="-0.02em" color={displayInk(chrome)} />
    </Card>
  )
}
