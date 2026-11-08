import { interpolate, Sequence, useCurrentFrame } from './clock'
import { type SimStep, Terminal, tui } from './Terminal'
import type { Lang } from './i18n'

// The same task on both accounts: the Claude side edits with Edit, the ChatGPT side with apply_patch (shown as Patch).
const HALF = 300
export const ACCOUNTS_DEMO_FRAMES = HALF * 2

const task = { en: 'set TOP_K to 20 in retrieval.py and run the tests', zh: '把 retrieval.py 的 TOP_K 改成 20，再跑測試' }

const steps = (lang: Lang, side: 'claude' | 'gpt'): SimStep[] => [
  { at: 10, type: 'line', text: side === 'claude' ? '$ claude' : '$ CLAUDE_CODE_USE_OPENAI=1 claude', color: 'inactive' },
  { at: 30, type: 'prompt', text: task[lang] },
  { at: 60, type: 'spinner', verb: side === 'claude' ? 'Pondering' : 'Reticulating', until: 95 },
  { at: 95, type: 'tool', name: 'Read', args: 'retrieval.py' },
  { at: 105, type: 'result', text: 'Read 6 lines' },
  side === 'claude'
    ? { at: 130, type: 'tool', name: 'Update', args: 'retrieval.py' }
    : { at: 130, type: 'tool', name: 'Patch', args: 'retrieval.py' },
  { at: 140, type: 'result', text: '- TOP_K = 10', color: 'error' },
  { at: 144, type: 'result', text: '+ TOP_K = 20', color: 'success' },
  { at: 170, type: 'tool', name: 'Bash', args: 'sh run_tests.sh' },
  { at: 185, type: 'result', text: '6 passed in 0.41s' },
  { at: 210, type: 'line', text: lang === 'en' ? 'TOP_K is 20 now; all 6 tests pass.' : 'TOP_K 已改成 20，6 個測試全部通過。' },
  { at: 225, type: 'done', verb: side === 'claude' ? 'Brewed' : 'Worked', seconds: 9 },
]

const Side: React.FC<{ lang: Lang; side: 'claude' | 'gpt' }> = ({ lang, side }) => {
  const f = useCurrentFrame()
  const accent = side === 'claude' ? tui.claude : tui.openai
  const label = side === 'claude' ? (lang === 'en' ? 'Claude account' : 'Claude 帳號') : lang === 'en' ? 'ChatGPT account' : 'ChatGPT 帳號'
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: interpolate(f, [0, 8, HALF - 8, HALF], [0, 1, 1, 0]) }}>
      <Terminal
        title="claude — ~/projects/search-demo"
        steps={steps(lang, side)}
        accent={accent}
        footer={{
          text: side === 'claude' ? `claude-sonnet-5-5 · medium · ${label}` : `gpt-6.1-sol · low · ${label}`,
          color: side === 'claude' ? 'claude' : 'openai',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: 12,
          top: 42,
          padding: '2px 10px',
          borderRadius: 12,
          background: accent,
          color: '#111',
          font: '600 12px "IBM Plex Sans", "Noto Sans TC", sans-serif',
        }}
      >
        {label}
      </div>
    </div>
  )
}

export const AccountsDemo: React.FC<{ lang: Lang }> = ({ lang }) => (
  <div style={{ position: 'absolute', inset: 0 }}>
    <Sequence durationInFrames={HALF}>
      <Side lang={lang} side="claude" />
    </Sequence>
    <Sequence from={HALF} durationInFrames={HALF}>
      <Side lang={lang} side="gpt" />
    </Sequence>
  </div>
)
