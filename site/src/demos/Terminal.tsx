import { interpolate, useCurrentFrame } from 'remotion'
import { TURN_COMPLETION_VERBS } from '../../../src/constants/turnCompletionVerbs'

// Dark theme colors from src/utils/theme.ts and spinner glyphs from src/components/Spinner/utils.ts.
export const tui = {
  claude: 'rgb(215,119,87)',
  claudeShimmer: 'rgb(235,159,127)',
  text: 'rgb(255,255,255)',
  inactive: 'rgb(153,153,153)',
  subtle: 'rgb(80,80,80)',
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  suggestion: 'rgb(177,185,249)',
  openai: 'rgb(95,214,193)',
  warning: 'rgb(255,193,7)',
  userMessageBackground: 'rgb(55,55,55)',
}
const SPINNER = ['·', '✢', '*', '✶', '✻', '✽']
const SPINNER_CYCLE = [...SPINNER, ...[...SPINNER].reverse()]
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
export const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

export type TuiColor = keyof typeof tui
export type SimStep =
  | { at: number; type: 'prompt'; text: string }
  | { at: number; type: 'spinner'; verb: string; until: number }
  | { at: number; type: 'tool'; name: string; args: string; color?: TuiColor }
  | { at: number; type: 'result'; text: string; color?: TuiColor }
  | { at: number; type: 'line'; text: string; color?: TuiColor }
  | { at: number; type: 'done'; verb: (typeof TURN_COMPLETION_VERBS)[number]; seconds: number }
  | { at: number; type: 'box'; title: string; lines: string[]; actions: string[]; color: TuiColor }

export const Terminal: React.FC<{ title: string; steps: SimStep[]; footer: { text: string; color: TuiColor }; accent: string }> = ({
  title,
  steps,
  footer,
  accent,
}) => {
  const frame = useCurrentFrame()
  const visible = steps.filter(s => frame >= s.at && !(s.type === 'spinner' && frame >= s.until))
  return (
    <div
      style={{
        position: 'absolute',
        inset: 40,
        borderRadius: 16,
        overflow: 'hidden',
        background: 'rgb(24,24,24)',
        border: `2px solid ${accent}55`,
        fontFamily: MONO,
        fontSize: 24,
        lineHeight: 1.55,
        color: tui.text,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', background: '#262523', flex: 'none' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map(c => (
          <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
        ))}
        <span style={{ marginLeft: 14, fontSize: 18, color: tui.inactive }}>{title}</span>
      </div>
      <div style={{ padding: '22px 32px', flex: 1, overflow: 'hidden' }}>
        {visible.map((s, i) => (
          <SimLine key={i} step={s} frame={frame} />
        ))}
      </div>
      <div style={{ borderTop: `2px solid ${tui.subtle}`, padding: '8px 32px', flex: 'none' }}>
        <span style={{ color: tui.inactive }}>❯ </span>
        <span style={{ opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0 }}>▋</span>
      </div>
      <div style={{ borderTop: `2px solid ${tui.subtle}`, padding: '6px 32px 12px', fontSize: 19, color: tui[footer.color], flex: 'none' }}>
        {footer.text}
      </div>
    </div>
  )
}

const SimLine: React.FC<{ step: SimStep; frame: number }> = ({ step, frame }) => {
  const local = frame - step.at
  const appear = { opacity: interpolate(local, [0, 4], [0, 1], clamp), translate: `${interpolate(local, [0, 6], [-16, 0], clamp)}px 0px` }
  switch (step.type) {
    case 'prompt': {
      const shown = step.text.slice(0, Math.round(interpolate(local, [0, 20], [0, step.text.length], clamp)))
      return (
        <div style={{ margin: '0 0 12px', padding: '2px 10px', background: tui.userMessageBackground, display: 'inline-block' }}>
          <span style={{ color: tui.inactive }}>❯ </span>
          {shown}
        </div>
      )
    }
    case 'spinner': {
      const glyph = SPINNER_CYCLE[Math.floor(frame / 3) % SPINNER_CYCLE.length]
      const sweep = (frame * 0.6) % (step.verb.length + 6)
      return (
        <div style={{ color: tui.claude, marginTop: 8 }}>
          {glyph}{' '}
          {[...`${step.verb}…`].map((c, i) => (
            <span key={i} style={{ color: Math.abs(i - sweep) < 2 ? tui.claudeShimmer : tui.claude }}>
              {c}
            </span>
          ))}
          <span style={{ color: tui.inactive }}> ({Math.floor(local / 30) + 1}s · esc to interrupt)</span>
        </div>
      )
    }
    case 'tool':
      return (
        <div style={{ ...appear, marginTop: 8 }}>
          <span style={{ color: tui[step.color ?? 'success'] }}>● </span>
          <b>{step.name}</b>({step.args})
        </div>
      )
    case 'result':
      return (
        <div style={{ ...appear, paddingLeft: 28, color: tui[step.color ?? 'inactive'] }}>
          ⎿{'  '}
          {step.text}
        </div>
      )
    case 'line':
      return <div style={{ ...appear, marginTop: 8, color: tui[step.color ?? 'text'] }}>{step.text}</div>
    case 'box':
      return (
        <div style={{ ...appear, marginTop: 10, border: `2px solid ${tui[step.color]}`, borderRadius: 6, padding: '6px 14px' }}>
          <div style={{ color: tui[step.color], fontWeight: 700 }}>⚠ {step.title}</div>
          {step.lines.map((l, i) => (
            <div key={i} style={{ color: i === 0 ? tui.text : tui.inactive }}>{l}</div>
          ))}
          <div style={{ fontWeight: 700 }}>{step.actions.map(a => `[ ${a} ]`).join('  ')}</div>
        </div>
      )
    case 'done':
      return (
        <div style={{ ...appear, marginTop: 8, color: tui.inactive }}>
          ✻ {step.verb} for {step.seconds}s
        </div>
      )
  }
}
