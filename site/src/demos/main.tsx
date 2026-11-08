import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountsDemo } from './AccountsDemo'
import { FPS, FrameContext } from './clock'
import type { Lang } from './i18n'
import { type Scene, SCENES, TOUR_FRAMES, TourDemo } from './TourDemo'
import { WEB_DEMO_FRAMES, WebDemo } from './WebDemo'

// The web demo is drawn on a 1280×720 canvas and scaled to fit; the terminals render at page size.
const DEMOS = {
  web: { component: WebDemo, frames: WEB_DEMO_FRAMES, canvas: { width: 1280, height: 720 } },
  accounts: { component: AccountsDemo, frames: TOUR_FRAMES, canvas: null },
  tour: { component: TourDemo, frames: TOUR_FRAMES, canvas: null },
} as const
const FADE_MS = 180

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

// Advances the frame while the demo is on screen, and starts over when `restart` changes.
function useFrame(el: HTMLElement, frames: number, restart: string): number {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const [frame, setFrame] = useState(still ? frames - 1 : 0)
  const start = useRef(0)
  useEffect(() => {
    if (still) return
    let raf = 0
    let visible = false
    let pausedAt = 0
    start.current = performance.now()
    setFrame(0)
    const tick = (now: number) => {
      setFrame(Math.floor(((now - start.current) / 1000) * FPS) % frames)
      raf = requestAnimationFrame(tick)
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting === visible) return
      visible = entry.isIntersecting
      if (visible) {
        start.current += performance.now() - pausedAt
        raf = requestAnimationFrame(tick)
      } else {
        pausedAt = performance.now()
        cancelAnimationFrame(raf)
      }
    })
    pausedAt = performance.now()
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [el, frames, restart, still])
  return frame
}

const Demo: React.FC<{ name: keyof typeof DEMOS; el: HTMLElement }> = ({ name, el }) => {
  const lang = useLang()
  const target = useScene(el)
  const { frames, canvas } = DEMOS[name]
  const Component = DEMOS[name].component as React.FC<{ lang: Lang; scene: Scene }>
  // Scene changes fade out, swap and fade back in, so scrolling never cuts mid-frame.
  const [scene, setScene] = useState(target)
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (target === scene) return
    setShown(false)
    const t = setTimeout(() => {
      setScene(target)
      setShown(true)
    }, FADE_MS)
    return () => clearTimeout(t)
  }, [target, scene])
  const frame = useFrame(el, frames, name === 'tour' ? scene : name)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / canvas.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el, canvas])
  const body = (
    <FrameContext.Provider value={frame}>
      <Component lang={lang} scene={scene} />
    </FrameContext.Provider>
  )
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease` }}>
      {canvas ? (
        <div style={{ position: 'absolute', left: 0, top: 0, width: canvas.width, height: canvas.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  )
}

for (const el of document.querySelectorAll<HTMLElement>('[data-demo]')) {
  const name = el.dataset.demo
  if (name && name in DEMOS) createRoot(el).render(<Demo name={name as keyof typeof DEMOS} el={el} />)
}
