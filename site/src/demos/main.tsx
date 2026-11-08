import { Player } from '@remotion/player'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ACCOUNTS_DEMO_FRAMES, AccountsDemo } from './AccountsDemo'
import type { Lang } from './i18n'
import { WEB_DEMO_FRAMES, WebDemo } from './WebDemo'

const DEMOS = {
  web: { component: WebDemo, frames: WEB_DEMO_FRAMES },
  accounts: { component: AccountsDemo, frames: ACCOUNTS_DEMO_FRAMES },
} as const

const currentLang = (): Lang => (document.documentElement.dataset.lang === 'zh' ? 'zh' : 'en')

// Follows the page's language toggle, which sets data-lang on <html>.
function useLang(): Lang {
  const [lang, setLang] = useState(currentLang)
  useEffect(() => {
    const observer = new MutationObserver(() => setLang(currentLang()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lang'] })
    return () => observer.disconnect()
  }, [])
  return lang
}

const Demo: React.FC<{ name: keyof typeof DEMOS }> = ({ name }) => {
  const lang = useLang()
  const { component, frames } = DEMOS[name]
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <Player
      component={component}
      inputProps={{ lang }}
      durationInFrames={frames}
      fps={30}
      compositionWidth={1280}
      compositionHeight={720}
      style={{ width: '100%', aspectRatio: '16 / 9' }}
      autoPlay={!still}
      initialFrame={still ? frames - 1 : 0}
      loop
      initiallyMuted
      showVolumeControls={false}
      controls
      clickToPlay
      acknowledgeRemotionLicense
    />
  )
}

for (const el of document.querySelectorAll<HTMLElement>('[data-demo]')) {
  const name = el.dataset.demo
  if (name && name in DEMOS) createRoot(el).render(<Demo name={name as keyof typeof DEMOS} />)
}
