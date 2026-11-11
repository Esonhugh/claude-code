import { useEffect, useRef, useState } from 'react'
import type { Recording, Style } from '../../record/convert'
import { FPS, useCurrentFrame } from './clock'

// Plays a tmux recording of the real CLI (see site/record/) frame by frame and holds the last screen.
// It draws a character grid the way a terminal does: the visitor's own terminal font, fixed cells,
// block elements filling their cell, wide characters spanning two cells.
const TERMINAL_FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace'
const LINE_HEIGHT = 1.2
const BG = 'rgb(24,24,24)'
const FG = 'rgb(229,229,229)'
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
// Block elements as [left, top, right, bottom] quarter boxes of the cell, so the logo has no seams between rows.
const QUADS: Record<string, [number, number, number, number][]> = {
  '█': [[0, 0, 1, 1]],
  '▀': [[0, 0, 1, 0.5]],
  '▄': [[0, 0.5, 1, 1]],
  '▌': [[0, 0, 0.5, 1]],
  '▐': [[0.5, 0, 1, 1]],
  '▘': [[0, 0, 0.5, 0.5]],
  '▝': [[0.5, 0, 1, 0.5]],
  '▖': [[0, 0.5, 0.5, 1]],
  '▗': [[0.5, 0.5, 1, 1]],
  '▛': [[0, 0, 1, 0.5], [0, 0.5, 0.5, 1]],
  '▜': [[0, 0, 1, 0.5], [0.5, 0.5, 1, 1]],
  '▙': [[0, 0, 0.5, 1], [0.5, 0.5, 1, 1]],
  '▟': [[0.5, 0, 1, 1], [0, 0.5, 0.5, 1]],
  '▚': [[0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1]],
  '▞': [[0.5, 0, 1, 0.5], [0, 0.5, 0.5, 1]],
}

function colors(s: Style) {
  return { fg: s.inv ? (s.bg ?? BG) : (s.fg ?? FG), bg: s.inv ? (s.fg ?? FG) : s.bg }
}

function css(s: Style): React.CSSProperties {
  const { fg, bg } = colors(s)
  return {
    color: fg,
    background: bg,
    fontWeight: s.b ? 700 : undefined,
    opacity: s.d ? 0.6 : undefined,
    fontStyle: s.i ? 'italic' : undefined,
    textDecoration: s.u ? 'underline' : undefined,
  }
}

const cell = (cols: number): React.CSSProperties => ({ display: 'inline-block', width: `${cols}ch`, height: '100%', verticalAlign: 'top', position: 'relative' })

function cells(text: string, style: Style) {
  const out: React.ReactNode[] = []
  let plain = ''
  const flush = () => {
    if (plain) out.push(plain)
    plain = ''
  }
  for (const c of text) {
    const quads = QUADS[c]
    if (quads) {
      flush()
      const { fg } = colors(style)
      out.push(
        <span key={out.length} style={cell(1)}>
          {quads.map(([l, t, r, b], i) => (
            <span key={i} style={{ position: 'absolute', left: `${l * 100}%`, top: `${t * 100}%`, right: `${(1 - r) * 100}%`, bottom: `${(1 - b) * 100}%`, background: fg }} />
          ))}
        </span>,
      )
    } else if (WIDE.test(c)) {
      flush()
      out.push(
        <span key={out.length} style={{ ...cell(2), textAlign: 'center' }}>
          {c}
        </span>,
      )
    } else plain += c
  }
  flush()
  return out
}

// The terminal font differs per visitor, so measure its advance width instead of assuming one.
function measureAdvance(): number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0.6
  ctx.font = `100px ${TERMINAL_FONT}`
  return ctx.measureText('M'.repeat(10)).width / 1000
}

export const ReplayTerminal: React.FC<{ title: string; recording: Recording }> = ({ title, recording }) => {
  const frame = useCurrentFrame()
  const ms = (frame / FPS) * 1000
  const { frames, lines, styles, cols, rows } = recording
  let shown = frames[0]
  for (const f of frames) {
    if (f[0] > ms) break
    shown = f
  }

  // Size the font so the recorded cols × rows fill the window, like a terminal window of that size.
  const screen = useRef<HTMLDivElement>(null)
  const [fontSize, setFontSize] = useState(13)
  useEffect(() => {
    const el = screen.current
    if (!el) return
    const advance = measureAdvance()
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setFontSize(Math.min(width / (cols * advance), height / (rows * LINE_HEIGHT)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [cols, rows])

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: BG, display: 'flex', flexDirection: 'column', borderRadius: 10 }}>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 12px', background: 'rgb(56,56,56)', borderBottom: '1px solid rgb(20,20,20)', flex: 'none', position: 'relative', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map(c => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, marginRight: 8 }} />
        ))}
        <span style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', fontSize: 13, color: 'rgb(200,200,200)', pointerEvents: 'none' }}>
          {title} — {cols}×{rows}
        </span>
      </div>
      <div ref={screen} style={{ flex: 1, padding: '6px 8px', minHeight: 0 }}>
        <div style={{ fontFamily: TERMINAL_FONT, fontSize, lineHeight: LINE_HEIGHT, color: FG, whiteSpace: 'pre', fontVariantLigatures: 'none' }}>
          {shown[1].map((id, i) => (
            <div key={i} style={{ height: `${LINE_HEIGHT}em` }}>
              {lines[id].map(([text, style], j) => (
                <span key={j} style={{ ...css(styles[style]), display: 'inline-block', height: '100%', verticalAlign: 'top' }}>
                  {cells(text, styles[style])}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
