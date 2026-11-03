import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Lang } from '../i18n'
import { Dialog } from './Dialog'
import { ChannelsBody, McpBody, ModsBody, PluginsBody } from './ExtensionDialogs'
import type { Control, ExtProps } from './extShared'
import { HooksBody } from './HooksDialog'
import { MemoryBody } from './MemoryDialog'
import { SettingsBody } from './Settings'
import type { DialogKind } from './Sidebar'
import { SkillsBody } from './SkillsDialog'
import { StatsBody } from './StatsDialog'
import type { T } from './ui'
import { zh } from './zhText'

export type { Palette, Theme } from './Settings'

const KEY_ROWS: (['inputGroup' | 'chatGroup' | 'pageGroup'] | [Parameters<T>[0], string])[] = [
  ['inputGroup'],
  ['keySend', 'Enter'],
  ['keyNewline', 'Shift+Enter'],
  ['keyMode', 'Shift+Tab'],
  ['keyComplete', '/'],
  ['chatGroup'],
  ['keyInterrupt', 'Esc'],
  ['keyCompact', '/compact'],
  ['pageGroup'],
  ['keySearch', 'Ctrl+K'],
  ['keyNew', 'Ctrl+Shift+O'],
  ['keyStatus', 'Ctrl+.'],
  ['keyHelp', '?'],
  ['keyCloseDialog', 'Esc'],
]

function KeysBody({ t }: { t: T }) {
  return (
    <>
      <div className="keys">
        {KEY_ROWS.map(([label, keys]) =>
          keys === undefined ? (
            <div className="kh" key={label}>
              {t(label)}
            </div>
          ) : (
            <span key={label} style={{ display: 'contents' }}>
              <span>{t(label)}</span>
              <span>
                {keys === '/compact'
                  ? keys
                  : keys.split('+').map((k, i) => (
                      <span key={k}>
                        {i > 0 && '+'}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
              </span>
            </span>
          ),
        )}
      </div>
      <p className="note">{t('keysNote')}</p>
    </>
  )
}

/** One dialog for related lists: Channels are MCP servers, Mods hook into the same events as hooks. */
function Tabbed({ tabs }: { tabs: [string, ReactNode][] }) {
  const [tab, setTab] = useState(0)
  return (
    <>
      <div className="settabs">
        {tabs.map(([label], i) => (
          <button type="button" key={label} data-dtab={label} aria-pressed={i === tab} onClick={() => setTab(i)}>
            {label}
          </button>
        ))}
      </div>
      {tabs[tab]![1]}
    </>
  )
}

const TITLES: Record<DialogKind, (t: T) => string> = {
  mcp: () => 'MCP',
  skills: () => 'Skills',
  plugins: t => t('plugins'),
  memory: t => t('memory'),
  hooks: () => 'Hooks',
  settings: t => t('settings'),
  stats: t => t('statsLabel'),
  keys: t => t('shortcuts'),
}

/** The sidebar's dialogs; the extension entries load their data from /api/ext and the open session. */
export function AppDialog({
  kind,
  t,
  lang,
  control,
  onClose,
  onUseSkill,
  onOpenSession,
  settings,
}: {
  kind: DialogKind
  t: T
  lang: Lang
  /** Control requests to the session on screen, when it is running. */
  control?: Control
  onClose: () => void
  onUseSkill: (name: string) => void
  onOpenSession: (id: string) => void
  settings: Omit<Parameters<typeof SettingsBody>[0], 't'>
}) {
  const [flashText, setFlashText] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const props: ExtProps = {
    z: text => zh(lang, text),
    lang,
    control,
    flash: text => {
      setFlashText(text)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setFlashText(undefined), 2200)
    },
  }
  return (
    <>
      <Dialog t={t} title={TITLES[kind](t)} onClose={onClose}>
        {kind === 'mcp' && (
          <Tabbed
            tabs={[
              [props.z('MCP 服务器'), <McpBody {...props} />],
              ['Channels', <ChannelsBody {...props} />],
            ]}
          />
        )}
        {kind === 'skills' && <SkillsBody {...props} onUse={onUseSkill} />}
        {kind === 'plugins' && <PluginsBody {...props} openai={settings.account?.provider === 'openai'} />}
        {kind === 'memory' && <MemoryBody {...props} onOpenSession={onOpenSession} />}
        {kind === 'hooks' && (
          <Tabbed
            tabs={[
              ['Hooks', <HooksBody {...props} />],
              ['Mods', <ModsBody {...props} />],
            ]}
          />
        )}
        {kind === 'stats' && <StatsBody z={props.z} />}
        {kind === 'settings' && <SettingsBody t={t} {...settings} />}
        {kind === 'keys' && <KeysBody t={t} />}
      </Dialog>
      {flashText && (
        <div className="flash" role="status" aria-live="polite">
          {flashText}
        </div>
      )}
    </>
  )
}
