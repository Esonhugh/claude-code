import { useEffect, useRef, useState } from 'react'
import type { Recording, Style } from '../../record/convert'
import { FPS, useCurrentFrame } from './clock'
import { MONO } from './Terminal'

// Plays a tmux recording of the real CLI (see site/record/) frame by frame and holds the last screen.
const LINE_HEIGHT = 1.25
const BG = 'rgb(24,24,24)'
const FG = 'rgb(255,255,255)'
// East Asian wide characters take two cells in the terminal; pin them to 2ch so columns stay aligned.
const WIDE = /([ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]+)/

function css(s: Style): React.CSSProperties {
  const fg = s.inv ? (s.bg ?? BG) : s.fg
  const bg = s.inv ? (s.fg ?? FG) : s.bg
  return {
    color: fg,
    background: bg,
    fontWeight: s.b ? 700 : undefined,
    opacity: s.d ? 0.6 : undefined,
    fontStyle: s.i ? 'italic' : undefined,
    textDecoration: s.u ? 'underline' : undefined,
  }
}

function cells(text: string) {
  return text.split(WIDE).map((part, i) =>
    i % 2 ? (
      [...part].map((c, j) => (
        <span key={`${i}-${j}`} style={{ display: 'inline-block', width: '2ch', textAlign: 'center' }}>
          {c}
        </span>
      ))
    ) : (
      part
    ),
  )
}

export const ReplayTerminal: React.FC<{ title: string; recording: Recording; accent: string }> = ({ title, recording, accent }) => {
  const frame = useCurrentFrame()
  const ms = (frame / FPS) * 1000
  const { frames, lines, styles, cols, rows } = recording
  let shown = frames[0]
  for (const f of frames) {
    if (f[0] > ms) break
    shown = f
  }

  // Size the font so the recorded cols × rows fill the screen area, like a terminal window of that size.
  const screen = useRef<HTMLDivElement>(null)
  const [fontSize, setFontSize] = useState(13)
  useEffect(() => {
    const el = screen.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setFontSize(Math.min(width / (cols * 0.6), height / (rows * LINE_HEIGHT)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [cols, rows])

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: BG, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 32, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', background: '#262523', borderBottom: `2px solid ${accent}`, flex: 'none', fontFamily: MONO }}>
        {['#ff5f57', '#febc2e', '#28c840'].map(c => (
          <div key={c} style={{ width: 10, height: 10, borderRadius: 5, background: c }} />
        ))}
        <span style={{ marginLeft: 8, fontSize: 12, color: 'rgb(153,153,153)' }}>{title}</span>
      </div>
      <div ref={screen} style={{ flex: 1, padding: '10px 14px', minHeight: 0 }}>
        <div style={{ fontFamily: MONO, fontSize, lineHeight: LINE_HEIGHT, color: FG, whiteSpace: 'pre', fontVariantLigatures: 'none' }}>
          {shown[1].map((id, i) => (
            <div key={i} style={{ height: `${LINE_HEIGHT}em` }}>
              {lines[id].map(([text, style], j) => (
                <span key={j} style={css(styles[style])}>
                  {cells(text)}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
