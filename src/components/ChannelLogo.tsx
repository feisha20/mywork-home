import { useEffect, useState } from 'react'

export function ChannelLogo({ logo, name, size = 36 }: { logo: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [logo])
  return logo && !failed ? <img src={logo} alt="" width={size} height={size} onError={() => setFailed(true)} />
    : <span className="channel-logo-fallback" aria-hidden="true" style={{ width: size, height: size }}>{name.slice(0, 2).toUpperCase()}</span>
}
