import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Account, FeatureKey, Usage, UsageWindow, WebSettings } from '../api'
import { type Lang, LANGS } from '../i18n'
import type { ModelOption } from '../protocol'
import { modelName } from './Message'
import { formatElapsed, type T } from './ui'

export type Theme = 'system' | 'light' | 'dark'
export type Palette = 'default' | 'clay' | 'mono'

const PALETTES: [Palette, 'paletteDefault' | 'paletteClay' | 'paletteMono', string, string][] = [
  ['default', 'paletteDefault', '#3a56c8', '#f3f4f7'],
  ['clay', 'paletteClay', '#b0573a', '#faf9f5'],
  ['mono', 'paletteMono', '#111111', '#ffffff'],
]

// The prototype's feature rows, each backed by a real setting (see accountBackend.ts).
const FEATURE_ROWS: [FeatureKey, Parameters<T>[0], Parameters<T>[0]][] = [
  ['autoCompact', 'featAutoCompact', 'featAutoCompactHint'],
  ['gitInstructions', 'featGit', 'featGitHint'],
  ['memoryExtraction', 'featMemory', 'featMemoryHint'],
  ['agentSummary', 'featAgentSummary', 'featAgentSummaryHint'],
  ['promptSuggestions', 'featSuggestions', 'featSuggestionsHint'],
]

export type ContextUsage = { totalTokens?: number; maxTokens?: number; autoCompactThreshold?: number }

/** What the Usage tab reads from the open session, when there is one. */
export type UsageSource = {
  usage: () => Promise<Usage>
  context?: () => Promise<ContextUsage>
  /** Tool calls in the transcript, by tool name. */
  tools: Record<string, number>
  subagents: number
  live: boolean
}

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

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function resetTime(lang: Lang, iso?: string | null): string | undefined {
  if (!iso) return undefined
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const sameDay = at.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(lang, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric', weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}

function Meter({ label, pct, sub }: { label: string; pct: number; sub?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="usage">
      <div className="ulabel">
        <b>{label}</b>
        <span className="mono">{p}%</span>
      </div>
      <div className="bar">
        <i style={{ width: `${p}%`, ...(p >= 80 && { background: '#c2410c' }) }} />
      </div>
      {sub && <small>{sub}</small>}
    </div>
  )
}

function UsageTab({
  t,
  lang,
  account,
  source,
  models,
}: {
  t: T
  lang: Lang
  account?: Account
  source: UsageSource
  models: ModelOption[]
}) {
  const [usage, setUsage] = useState<Usage>()
  const [failed, setFailed] = useState(false)
  const [context, setContext] = useState<ContextUsage>()
  // Read once when the tab opens; the page re-renders while a turn streams.
  const first = useRef(source)
  useEffect(() => {
    first.current.usage().then(setUsage, () => setFailed(true))
    first.current.context?.().then(setContext, () => {})
  }, [])
  if (!usage && !failed) return <p className="note">{t('loading')}</p>
  const apikey = account?.kind === 'apikey'
  const limits = usage?.rate_limits
  const windows: [string, UsageWindow | null | undefined][] = limits
    ? [
        [t('window5h'), limits.five_hour],
        [t('weekAll'), limits.seven_day],
        ...(limits.model_scoped?.length
          ? limits.model_scoped.map(row => [t('weekScoped', { name: row.display_name }), row] as [string, UsageWindow])
          : ([
              [t('weekScoped', { name: 'Opus' }), limits.seven_day_opus],
              [t('weekScoped', { name: 'Sonnet' }), limits.seven_day_sonnet],
            ] as [string, UsageWindow | null | undefined][])),
      ]
    : []
  const session = source.live ? usage?.session : undefined
  const rows = Object.entries(session?.model_usage ?? {})
  const sum = (pick: (u: (typeof rows)[number][1]) => number | undefined) => rows.reduce((n, [, u]) => n + (pick(u) ?? 0), 0)
  const input = sum(u => u.inputTokens)
  const cacheRead = sum(u => u.cacheReadInputTokens)
  const cacheWrite = sum(u => u.cacheCreationInputTokens)
  const allInput = input + cacheRead + cacheWrite
  const cost = `$${(session?.total_cost_usd ?? 0).toFixed(2)}`
  const tools = Object.entries(source.tools).sort((a, b) => b[1] - a[1])
  const toolTotal = tools.reduce((n, [, c]) => n + c, 0)
  const ctxPct = context?.totalTokens !== undefined && context.maxTokens ? (context.totalTokens / context.maxTokens) * 100 : undefined
  return (
    <div>
      {apikey && !limits ? (
        <div className="usegroup">
          <h4>
            {t('costTitle')}{' '}
            <small>
              {account.source} · {t('payAsYouGo')}
            </small>
          </h4>
          <dl className="kv">
            <dt>{t('thisSession')}</dt>
            <dd>{session ? cost : '—'}</dd>
          </dl>
        </div>
      ) : (
        <div className="usegroup">
          <h4>{t('planLimits')}</h4>
          {windows
            .filter((w): w is [string, UsageWindow] => !!w[1] && typeof w[1].utilization === 'number')
            .map(([label, w]) => {
              const time = resetTime(lang, w.resets_at)
              return <Meter key={label} label={label} pct={w.utilization} sub={time && t('resetsAt', { time })} />
            })}
          {limits ? (
            <small className="note">{t(limits.extra_usage?.is_enabled ? 'extraUsageOn' : 'extraUsageOff')}</small>
          ) : (
            <small className="note">{t('limitsUnavailable')}</small>
          )}
        </div>
      )}
      <div className="usegroup">
        <h4>{t('thisSession')}</h4>
        {session ? (
          <>
            <table className="utable">
              <thead>
                <tr>
                  <th>{t('colModel')}</th>
                  <th>{t('colInput')}</th>
                  <th>{t('colOutput')}</th>
                  <th>{t('colCacheRead')}</th>
                  <th>{t('colCacheWrite')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([id, u]) => (
                  <tr key={id}>
                    <td>{modelName(id, models) ?? id}</td>
                    <td>{fmtTokens(u.inputTokens ?? 0)}</td>
                    <td>{fmtTokens(u.outputTokens ?? 0)}</td>
                    <td>{fmtTokens(u.cacheReadInputTokens ?? 0)}</td>
                    <td>{fmtTokens(u.cacheCreationInputTokens ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <small className="note">
              {apikey ? t('costExact', { cost }) : t('costApprox', { cost })} ·{' '}
              {t('apiDuration', { time: formatElapsed(session.total_api_duration_ms ?? 0) })} ·{' '}
              {t('wallClock', { time: formatElapsed(session.total_duration_ms ?? 0) })}
            </small>
          </>
        ) : (
          <small className="note">{t('noLiveSession')}</small>
        )}
      </div>
      {session && (
        <div className="usegroup">
          <h4>
            {t('metrics')} <small>{t('thisSession')}</small>
          </h4>
          <div className="mgrid">
            <div>
              <small>{t('cacheHit')}</small>
              <b>{allInput ? `${Math.round((cacheRead / allInput) * 100)}%` : '—'}</b>
              <small>{t('cacheHitSub', { read: fmtTokens(cacheRead), input: fmtTokens(allInput) })}</small>
            </div>
            <div>
              <small>{t('toolCalls')}</small>
              <b>{toolTotal}</b>
              <small>{tools.slice(0, 3).map(([name, c]) => `${name} ${c}`).join(' · ') || '—'}</small>
            </div>
            <div>
              <small>{t('linesChanged')}</small>
              <b>
                +{session.total_lines_added ?? 0} −{session.total_lines_removed ?? 0}
              </b>
            </div>
            <div>
              <small>subagent</small>
              <b>{source.subagents}</b>
            </div>
          </div>
        </div>
      )}
      {ctxPct !== undefined && context?.maxTokens && (
        <div className="usegroup">
          <h4>{t('contextGroup')}</h4>
          <Meter
            label={t('currentConversation')}
            pct={ctxPct}
            sub={[
              `${fmtTokens(context.totalTokens!)} / ${fmtTokens(context.maxTokens)}`,
              context.autoCompactThreshold !== undefined &&
                t('autoCompactLeft', { left: fmtTokens(context.maxTokens - context.autoCompactThreshold) }),
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        </div>
      )}
    </div>
  )
}

/** Settings pane: General, Usage and Features tabs as the prototype lays them out. */
export function SettingsBody({
  t,
  lang,
  setLang,
  theme,
  setTheme,
  palette,
  setPalette,
  workspace,
  settings,
  onSettings,
  account,
  usage,
  models,
}: {
  t: T
  lang: Lang
  setLang: (lang: Lang) => void
  theme: Theme
  setTheme: (theme: Theme) => void
  palette: Palette
  setPalette: (palette: Palette) => void
  workspace?: string
  settings?: WebSettings
  onSettings: (patch: { uiName?: string; features?: Partial<Record<FeatureKey, boolean>> }) => void
  account?: Account
  usage: UsageSource
  models: ModelOption[]
}) {
  const [tab, setTab] = useState<'general' | 'usage' | 'features'>('general')
  const [uiName, setUiName] = useState(settings?.uiName ?? '')
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined)
  const loadedName = settings?.uiName
  useEffect(() => {
    if (loadedName !== undefined && !typing.current) setUiName(loadedName)
  }, [loadedName])
  const changeName = (value: string) => {
    setUiName(value)
    clearTimeout(typing.current)
    typing.current = setTimeout(() => {
      typing.current = undefined
      onSettings({ uiName: value.trim() })
    }, 400)
  }
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
      {tab === 'general' && (
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
            <input
              id="ui-name-input"
              className="mono"
              maxLength={32}
              value={uiName}
              placeholder="EsonClaw"
              aria-label="uiName"
              disabled={!settings}
              onChange={e => changeName(e.target.value)}
            />
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
          <div className="setrow">
            <div>
              <b>{t('lanAccess')}</b>
              <small>{t('lanAccessHint')}</small>
            </div>
            <span className={`badge ${settings?.allow_local_network ? 'completed' : 'idle'}`}>
              {t(settings?.allow_local_network ? 'lanOn' : 'lanOff')}
            </span>
          </div>
        </div>
      )}
      {tab === 'usage' && <UsageTab t={t} lang={lang} account={account} source={usage} models={models} />}
      {tab === 'features' && (
        <div>
          {FEATURE_ROWS.map(([key, title, hint]) => (
            <div className="setrow" key={key}>
              <div>
                <b>{t(title)}</b>
                <small>{t(hint)}</small>
              </div>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-checked={settings?.features[key] ?? false}
                aria-label={t(title)}
                disabled={!settings}
                onClick={() => settings && onSettings({ features: { [key]: !settings.features[key] } })}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
