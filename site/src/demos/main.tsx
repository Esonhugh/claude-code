import { Player } from '@remotion/player'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ACCOUNTS_DEMO_FRAMES, AccountsDemo } from './AccountsDemo'
import { type Scene, SCENES, TOUR_FRAMES, TourDemo } from './TourDemo'
import type { Lang } from './i18n'
import { WEB_DEMO_FRAMES, WebDemo } from './WebDemo'

const DEMOS = {
  web: { component: WebDemo, frames: WEB_DEMO_FRAMES },
  accounts: { component: AccountsDemo, frames: ACCOUNTS_DEMO_FRAMES },
  tour: { component: TourDemo, frames: TOUR_FRAMES },
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

// The tour's scene follows data-scene on its container, which the page's scroll observer sets.
function useScene(el: HTMLElement): Scene {
  const read = (): Scene => (SCENES.includes(el.dataset.scene as Scene) ? (el.dataset.scene as Scene) : 'accounts')
  const [scene, setScene] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setScene(read()))
    observer.observe(el, { attributes: true, attributeFilter: ['data-scene'] })
    return () => observer.disconnect()
  }, [el])
  return scene
}

const Demo: React.FC<{ name: keyof typeof DEMOS; el: HTMLElement }> = ({ name, el }) => {
  const lang = useLang()
  const scene = useScene(el)
  const { component, frames } = DEMOS[name]
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <Player
      key={name === 'tour' ? scene : undefined}
      component={component as React.ComponentType<{ lang: Lang; scene: Scene }>}
      inputProps={{ lang, scene }}
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
  if (name && name in DEMOS) createRoot(el).render(<Demo name={name as keyof typeof DEMOS} el={el} />)
}
