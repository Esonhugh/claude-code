import { AccountsDemo } from './AccountsDemo'
import type { Lang } from './i18n'
import { type SimStep, Terminal, tui } from './Terminal'

// Scenes for the scroll-driven tour on the landing page. Each one fits in TOUR_FRAMES and holds its last frame.
export const TOUR_FRAMES = 600
export type Scene = 'accounts' | 'goal' | 'teams' | 'tmux' | 'mods' | 'context'
export const SCENES: Scene[] = ['accounts', 'goal', 'teams', 'tmux', 'mods', 'context']

const L = (lang: Lang, en: string, zh: string) => (lang === 'en' ? en : zh)

const scripts: Record<Exclude<Scene, 'accounts'>, (lang: Lang) => SimStep[]> = {
  goal: lang => [
    { at: 10, type: 'prompt', text: '/goal all tests pass' },
    { at: 40, type: 'spinner', verb: 'Pondering', until: 75 },
    { at: 75, type: 'tool', name: 'Bash', args: 'bun test' },
    { at: 88, type: 'result', text: '12 pass · 2 fail', color: 'error' },
    { at: 115, type: 'line', text: 'Goal not yet met… continuing', color: 'warning' },
    { at: 145, type: 'tool', name: 'Update', args: 'src/parser.ts' },
    { at: 155, type: 'result', text: L(lang, 'Updated src/parser.ts with 3 additions', '已更新 src/parser.ts，新增 3 行') },
    { at: 185, type: 'tool', name: 'Bash', args: 'bun test' },
    { at: 198, type: 'result', text: '14 pass · 0 fail', color: 'success' },
    { at: 230, type: 'line', text: '✔ Goal achieved (41s · 2 turns · 38.6k tokens)', color: 'success' },
  ],
  teams: lang => [
    { at: 10, type: 'prompt', text: L(lang, 'form a team of three: code, tests, docs. Name each one', '組一個三人團隊：程式、測試、文件，每人取名') },
    { at: 45, type: 'spinner', verb: 'Pondering', until: 80 },
    { at: 80, type: 'tool', name: 'TeamCreate', args: 'release' },
    { at: 105, type: 'tool', name: 'Agent', args: 'coder' },
    { at: 118, type: 'tool', name: 'Agent', args: 'tester' },
    { at: 131, type: 'tool', name: 'Agent', args: 'writer' },
    { at: 160, type: 'line', text: '  ● main   ◯ coder   ◯ tester   ◯ writer', color: 'inactive' },
    { at: 200, type: 'tool', name: 'SendMessage', args: 'to: tester' },
    { at: 212, type: 'result', text: L(lang, 'tester: 9 new tests, all green', 'tester：新增 9 個測試，全部通過') },
    { at: 240, type: 'result', text: L(lang, 'writer: CHANGES.md drafted', 'writer：CHANGES.md 已完成') },
    { at: 270, type: 'done', verb: 'Cooked', seconds: 52 },
  ],
  tmux: lang => [
    { at: 10, type: 'prompt', text: L(lang, 'open a python REPL and compute 2**64', '開一個 python REPL，算 2**64') },
    { at: 40, type: 'spinner', verb: 'Pondering', until: 70 },
    { at: 70, type: 'tool', name: 'Tmux', args: 'action=new-session, command=python3' },
    { at: 85, type: 'result', text: 'Python 3.13.1 · >>>' },
    { at: 115, type: 'tool', name: 'Tmux', args: 'action=send-keys, text="2**64", enter=true' },
    { at: 130, type: 'result', text: '18446744073709551616', color: 'text' },
    { at: 160, type: 'tool', name: 'Tmux', args: 'action=send-keys, key=C-d' },
    { at: 190, type: 'line', text: L(lang, '2**64 = 18446744073709551616. The REPL is closed.', '2**64 = 18446744073709551616，REPL 已關閉。') },
    { at: 210, type: 'done', verb: 'Worked', seconds: 7 },
  ],
  mods: lang => [
    { at: 10, type: 'line', text: '$ claude --plugin-dir ./examples/mods/blast-radius', color: 'inactive' },
    { at: 30, type: 'prompt', text: L(lang, 'clear the build directory', '清掉 build 目錄') },
    { at: 60, type: 'tool', name: 'Bash', args: 'rm -rf build' },
    { at: 70, type: 'result', text: 'Running…' },
    {
      at: 95,
      type: 'box',
      title: 'rm -r',
      color: 'warning',
      lines: ['$ rm -rf build', L(lang, 'It would delete 3 files under build.', '會刪除 build 底下 3 個檔案。'), '  build/a.js', '  build/b.js', '  build/c.js'],
      actions: ['Proceed', 'Cancel'],
    },
  ],
  context: lang => [
    { at: 10, type: 'prompt', text: '/context-window 200k' },
    { at: 30, type: 'result', text: 'Auto-compact window for claude-sonnet-5-5 set to 200k tokens' },
    { at: 70, type: 'prompt', text: '/context' },
    { at: 90, type: 'result', text: L(lang, 'System prompt 9.4k · Tools 6.1k · Messages 41.0k', '系統提示 9.4k · 工具 6.1k · 對話 41.0k') },
    { at: 104, type: 'result', text: L(lang, '56.5k / 200k (28%) · auto-compact at 200k', '56.5k / 200k（28%）· 200k 時自動壓縮') },
    { at: 140, type: 'prompt', text: '/compact' },
    { at: 160, type: 'result', text: 'Compacted (ctrl+o to see full summary)' },
  ],
}

export const TourDemo: React.FC<{ lang: Lang; scene: Scene }> = ({ lang, scene }) => {
  if (scene === 'accounts') return <AccountsDemo lang={lang} />
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Terminal
        title="claude — ~/projects/search-demo"
        steps={scripts[scene](lang)}
        accent={tui.claude}
        footer={{ text: scene === 'goal' ? 'Goal is set · claude-sonnet-5-5 · medium' : 'claude-sonnet-5-5 · medium', color: 'inactive' }}
      />
    </div>
  )
}
