import { brand } from '../brand'
import { Serif } from '../type'
import { Card, Chrome, displayInk, bodyMuted } from '../layout'
import { Avatar } from '../avatar'

interface Props {
  name: string
  role: string
  avatar?: string
  eyebrow?: string
  size: { width: number; height: number }
  chrome?: Chrome
}

// Team member, editorial like the rest of the kit: mono tick eyebrow, avatar,
// big left-aligned serif name, one-line sans role beneath.
export function teamMember({ name, role, avatar, eyebrow, size, chrome }: Props) {
  return (
    <Card size={size} chrome={chrome} align="center" eyebrow={eyebrow}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 44, width: '100%' }}>
        <Avatar src={avatar} initial={name.trim().charAt(0)} d={240} dark={chrome?.dark} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, width: '100%' }}>
          <Serif text={name} size={124} leading={0.98} tracking="-0.025em" color={displayInk(chrome)} italic />
          <div style={{ display: 'flex', fontSize: brand.type.sizes.base, color: bodyMuted(chrome), lineHeight: 1.4, maxWidth: 760 }}>
            {role}
          </div>
        </div>
      </div>
    </Card>
  )
}
