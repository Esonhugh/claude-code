import { useState } from 'react'
import type { Hook, SessionEnv } from '../protocol'
import { Dialog } from './Dialog'
import { SettingsBody } from './Settings'
import type { DialogKind } from './Sidebar'
import type { T } from './ui'

export type { Palette, Theme } from './Settings'

const MCP_BADGE: Record<string, ['completed' | 'killed' | 'idle', 'connected' | 'needsAuth' | 'connectFailedBadge' | 'connecting']> = {
  connected: ['completed', 'connected'],
  'needs-auth': ['idle', 'needsAuth'],
  failed: ['killed', 'connectFailedBadge'],
  pending: ['idle', 'connecting'],
}

function McpBody({ t, env }: { t: T; env: SessionEnv }) {
  if (!env.mcpServers?.length) return <p className="note">{t('notYet')}</p>
  return (
    <div>
      {env.mcpServers.map(server => {
        const badge = MCP_BADGE[server.status]
        return (
          <div className="xrow" key={server.name}>
            <div>
              <b className="mono">{server.name}</b>
            </div>
            <div className="acts">
              <span className={`badge ${badge?.[0] ?? 'idle'}`}>{badge ? t(badge[1]) : server.status}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SkillsBody({ t, env, onUse }: { t: T; env: SessionEnv; onUse: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const skills = env.skills ?? []
  const hits = skills.filter(name => name.toLowerCase().includes(query.trim().toLowerCase()))
  const [open, setOpen] = useState<string>()
  const current = hits.includes(open ?? '') ? open : hits[0]
  if (!skills.length) return <p className="note">{t('notYet')}</p>
  return (
    <>
      <div className="memsearch">
        <input
          placeholder={t('searchSkill')}
          aria-label={t('searchSkill')}
          value={query}
          autoComplete="off"
          autoFocus
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      <div className="memgrid">
        <div className="memlist">
          {hits.map(name => (
            <button type="button" key={name} aria-current={name === current} onClick={() => setOpen(name)}>
              /{name}
            </button>
          ))}
          {!hits.length && (
            <p className="note" style={{ padding: '6px 8px' }}>
              {t('noMatchingSkill')}
            </p>
          )}
        </div>
        {current && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <div className="xrow" style={{ border: 0, padding: 0 }}>
              <div>
                <b className="mono">/{current}</b>
              </div>
              <div className="acts">
                <button className="btn primary" type="button" onClick={() => onUse(current)}>
                  {t('useInChat')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function PluginsBody({ t, env }: { t: T; env: SessionEnv }) {
  if (!env.plugins?.length) return <p className="note">{t('noPlugins')}</p>
  return (
    <div>
      {env.plugins.map(plugin => (
        <div className="xrow" key={plugin.path}>
          <div>
            <b>{plugin.name}</b>
            <small className="mono">{plugin.path}</small>
          </div>
          <div className="acts">
            <span className="badge completed">{t('installed')}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function HooksBody({ t, hooks }: { t: T; hooks?: Hook[] }) {
  if (!hooks?.length) return <p className="note">{t('notYet')}</p>
  const events = [...new Set(hooks.map(h => h.event))]
  return (
    <>
      {events.map(event => (
        <div key={event}>
          <div className="grp-h mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {event}
          </div>
          {hooks
            .filter(h => h.event === event)
            .map((h, i) => (
              <div className="xrow hookrow" key={i}>
                <div>
                  <b className="mono">{h.matcher || t('allMatch')}</b>
                  <small>
                    <code>{h.command}</code>
                    {h.timeout !== undefined && ` · ${h.timeout}s`}
                  </small>
                </div>
                <div className="acts">
                  <span className="note">{t('readOnly')}</span>
                </div>
              </div>
            ))}
        </div>
      ))}
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
  skills: () => 'Skills',
  plugins: t => t('plugins'),
  memory: t => t('memory'),
  hooks: () => 'Hooks',
  mods: () => 'Mods',
  settings: t => t('settings'),
  stats: () => 'Stats',
  keys: t => t('shortcuts'),
}

/** The sidebar's dialogs. Entries the session cannot report yet show an empty state. */
export function AppDialog({
  kind,
  t,
  env,
  onClose,
  onUseSkill,
  settings,
}: {
  kind: DialogKind
  t: T
  env: SessionEnv
  onClose: () => void
  onUseSkill: (name: string) => void
  settings: Omit<Parameters<typeof SettingsBody>[0], 't'>
}) {
  return (
    <Dialog t={t} title={TITLES[kind](t)} onClose={onClose}>
      {kind === 'mcp' && <McpBody t={t} env={env} />}
      {kind === 'skills' && <SkillsBody t={t} env={env} onUse={onUseSkill} />}
      {kind === 'plugins' && <PluginsBody t={t} env={env} />}
      {kind === 'hooks' && <HooksBody t={t} hooks={env.hooks} />}
      {kind === 'settings' && <SettingsBody t={t} {...settings} />}
      {kind === 'keys' && <KeysBody t={t} />}
      {(kind === 'memory' || kind === 'mods' || kind === 'stats') && <p className="note">{t('notYet')}</p>}
    </Dialog>
  )
}
