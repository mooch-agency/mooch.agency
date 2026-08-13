import { Serif } from '../type'
import { Card, Chrome, displayInk } from '../layout'
import { Avatar } from '../avatar'

interface Props {
  avatars: (string | undefined)[]
  initials?: (string | undefined)[]
  line: string
  eyebrow?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

// Team cover, editorial: mono tick eyebrow, a row of avatars, big left-aligned
// serif line beneath.
export function teamCover({ avatars, initials, line, eyebrow, size, chrome }: Props) {
  return (
    <Card size={size} chrome={chrome} align="center" eyebrow={eyebrow}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 60, width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 32 }}>
          {avatars.map((a, i) => (
            <Avatar key={i} src={a} initial={initials?.[i]} d={240} dark={chrome?.dark} />
          ))}
        </div>
        <Serif text={line} size={112} leading={1.0} tracking="-0.025em" color={displayInk(chrome)} maxWidth="94%" />
      </div>
    </Card>
  )
}
