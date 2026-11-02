import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type Lang, LANGS } from '../i18n'
import { Dialog } from './Dialog'
import { ChannelsBody, McpBody, ModsBody, PluginsBody } from './ExtensionDialogs'
import type { Control, ExtProps } from './extShared'
import { HooksBody } from './HooksDialog'
import { MemoryBody } from './MemoryDialog'
import type { DialogKind } from './Sidebar'
import { SkillsBody } from './SkillsDialog'
import { StatsBody } from './StatsDialog'
import type { T } from './ui'
import { zh } from './zhText'

export type Theme = 'system' | 'light' | 'dark'
export type Palette = 'default' | 'clay' | 'mono'

const PALETTES: [Palette, 'paletteDefault' | 'paletteClay' | 'paletteMono', string, string][] = [
  ['default', 'paletteDefault', '#3a56c8', '#f3f4f7'],
  ['clay', 'paletteClay', '#b0573a', '#faf9f5'],
  ['mono', 'paletteMono', '#111111', '#ffffff'],
]

function Seg<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: V
  options: { value: V; label: ReactNode }[]
  onChange: (v: V) => void
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button type="button" role="radio" key={o.value} aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SettingsBody({
  t,
  lang,
  setLang,
  uiName,
  theme,
  setTheme,
  palette,
  setPalette,
  workspace,
}: {
  t: T
  lang: Lang
  setLang: (lang: Lang) => void
  uiName: string
  theme: Theme
  setTheme: (theme: Theme) => void
  palette: Palette
  setPalette: (palette: Palette) => void
  workspace?: string
}) {
  const [tab, setTab] = useState<'general' | 'usage' | 'features'>('general')
  const tabs = [
    ['general', t('general')],
    ['usage', t('usageTab')],
    ['features', t('featuresTab')],
  ] as const
  return (
    <>
      <div className="settabs">
        {tabs.map(([key, label]) => (
          <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'general' ? (
        <div>
          <div className="setrow">
            <div>
              <b>{t('uiLanguage')}</b>
              <small>{t('uiLanguageHint')}</small>
            </div>
            <Seg label="Language" value={lang} options={LANGS.map(l => ({ value: l.id, label: l.label }))} onChange={setLang} />
          </div>
          <div className="setrow">
            <div>
              <b>{t('uiName')}</b>
              <small>{t('uiNameHint')}</small>
            </div>
            <span className="mono">{uiName}</span>
          </div>
          <div className="setrow">
            <div>
              <b>{t('appearance')}</b>
              <small>{t('appearanceHint')}</small>
            </div>
            <Seg
              label={t('appearance')}
              value={theme}
              options={[
                { value: 'system', label: t('themeSystem') },
                { value: 'light', label: t('themeLight') },
                { value: 'dark', label: t('themeDark') },
              ]}
              onChange={setTheme}
            />
          </div>
          <div className="setrow">
            <div>
              <b>{t('palette')}</b>
              <small>{t('paletteHint')}</small>
            </div>
            <Seg
              label={t('palette')}
              value={palette}
              options={PALETTES.map(([value, key, a, b]) => ({
                value,
                label: (
                  <>
                    <span className="swatch" aria-hidden="true">
                      <i style={{ background: a }} />
                      <i style={{ background: b }} />
                    </span>
                    {t(key)}
                  </>
                ),
              }))}
              onChange={setPalette}
            />
          </div>
          {workspace && (
            <div className="setrow">
              <div>
                <b>{t('workDir')}</b>
                <small>{t('workDirHint')}</small>
              </div>
              <span className="mono">{workspace}</span>
            </div>
          )}
          <div className="setrow">
            <div>
              <b>{t('accessAddress')}</b>
              <small>{t('accessAddressHint')}</small>
            </div>
            <span className="mono">{location.host}</span>
          </div>
        </div>
      ) : (
        <p className="note">{t('notYet')}</p>
      )}
    </>
  )
}

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

const TITLES: Record<DialogKind, (t: T) => string> = {
  mcp: t => t('mcpTitle'),
  channels: () => 'Channels',
  skills: () => 'Skills',
  plugins: t => t('plugins'),
  memory: t => t('memory'),
  hooks: () => 'Hooks',
  mods: () => 'Mods',
  settings: t => t('settings'),
  stats: () => 'Stats',
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
        {kind === 'mcp' && <McpBody {...props} />}
        {kind === 'channels' && <ChannelsBody {...props} />}
        {kind === 'skills' && <SkillsBody {...props} onUse={onUseSkill} />}
        {kind === 'plugins' && <PluginsBody {...props} />}
        {kind === 'memory' && <MemoryBody {...props} onOpenSession={onOpenSession} />}
        {kind === 'hooks' && <HooksBody {...props} />}
        {kind === 'mods' && <ModsBody {...props} />}
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
