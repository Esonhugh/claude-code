import { type ReactNode, useEffect, useState } from 'react'
import { type ChannelPlugin, ext, type Mod, type Profile, type SessionConfig, sessionConfig } from '../extApi'
import { errorText, type ExtProps, Switch } from './extShared'
import { Pick } from './HooksDialog'

/** What the editor can list: installed plugins, mods, the open session's MCP servers, channel plugins. */
type Sources = {
  plugins: { id: string; on: boolean; description: string }[]
  mods: Mod[]
  mcp: { name: string; on: boolean }[]
  channels: ChannelPlugin[]
}

type Tri = 'inherit' | 'on' | 'off'

function Seg({ z, value, base, onChange, name }: { z: ExtProps['z']; value: Tri; base: boolean; name: string; onChange: (v: Tri) => void }) {
  const options: [Tri, string][] = [
    ['inherit', z(base ? '跟随（开）' : '跟随（关）')],
    ['on', z('开')],
    ['off', z('关')],
  ]
  return (
    <span className="seg" role="radiogroup" aria-label={name}>
      {options.map(([v, label]) => (
        <button type="button" role="radio" key={v} aria-checked={value === v} data-sc={`${name}:${v}`} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </span>
  )
}

const triOf = (map: Record<string, boolean> | undefined, key: string): Tri =>
  map?.[key] === undefined ? 'inherit' : map[key] ? 'on' : 'off'

function setTri(map: Record<string, boolean> | undefined, key: string, v: Tri): Record<string, boolean> | undefined {
  const next = { ...map }
  if (v === 'inherit') delete next[key]
  else next[key] = v === 'on'
  return Object.keys(next).length ? next : undefined
}

function clean(config: SessionConfig): SessionConfig {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) as SessionConfig
}

/**
 * Plugins, mods, MCP servers, channels and hooks of one config. `base` is what
 * an entry left on "follow" gets: the profile's config under a session, the
 * global settings for a profile.
 */
function ConfigEditor({
  z,
  value,
  base,
  sources,
  onChange,
}: {
  z: ExtProps['z']
  value: SessionConfig
  base: SessionConfig
  sources: Sources
  onChange: (next: SessionConfig) => void
}) {
  const set = (patch: Partial<SessionConfig>) => onChange(clean({ ...value, ...patch }))
  const pluginOn = (id: string, global: boolean) => base.plugins?.[id] ?? global
  const mods = new Set(sources.mods.map(m => m.plugin))
  const row = (key: string, name: string, sub: string, control: ReactNode) => (
    <div className="xrow" key={key}>
      <div>
        <b className="mono">{name}</b>
        {sub && <small>{sub}</small>}
      </div>
      <div className="acts">{control}</div>
    </div>
  )
  const channelsCustom = value.channels !== undefined
  const baseChannels = base.channels
  // What "follow" gives: the profile's list, else the new-session defaults.
  const inherited = baseChannels ?? sources.channels.filter(c => c.def).map(c => `plugin:${c.plugin}`)
  const channelOn = (entry: string) => (value.channels ?? inherited).includes(entry)
  return (
    <>
      <div className="grp-h">{z('插件')}</div>
      {sources.plugins.filter(p => !mods.has(p.id)).length === 0 && <p className="note">{z('还没有安装插件。')}</p>}
      {sources.plugins
        .filter(p => !mods.has(p.id))
        .map(p =>
          row(
            `p:${p.id}`,
            p.id,
            p.description,
            <Seg
              z={z}
              name={`plugin:${p.id}`}
              value={triOf(value.plugins, p.id)}
              base={pluginOn(p.id, p.on)}
              onChange={v => set({ plugins: setTri(value.plugins, p.id, v) })}
            />,
          ),
        )}
      <div className="grp-h" style={{ marginTop: 10 }}>
        Mods
      </div>
      {sources.mods.length === 0 && <p className="note">{z('没有带 hook 模块的插件。')}</p>}
      {sources.mods.map(m =>
        row(
          `m:${m.plugin}`,
          m.id,
          m.description,
          <Seg
            z={z}
            name={`mod:${m.plugin}`}
            value={triOf(value.plugins, m.plugin)}
            base={pluginOn(m.plugin, m.on)}
            onChange={v => set({ plugins: setTri(value.plugins, m.plugin, v) })}
          />,
        ),
      )}
      <div className="grp-h" style={{ marginTop: 10 }}>
        {z('MCP 服务器')}
      </div>
      {sources.mcp.length === 0 && <p className="note">{z('打开一个运行中的会话后才能列出 MCP 服务器。')}</p>}
      {sources.mcp.map(s =>
        row(
          `s:${s.name}`,
          s.name,
          '',
          <Seg
            z={z}
            name={`mcp:${s.name}`}
            value={triOf(value.mcp, s.name)}
            base={base.mcp?.[s.name] ?? s.on}
            onChange={v => set({ mcp: setTri(value.mcp, s.name, v) })}
          />,
        ),
      )}
      <div className="grp-h" style={{ marginTop: 10 }}>
        Channels
      </div>
      {row(
        'c:mode',
        z(channelsCustom ? '自定义' : baseChannels ? '跟随模版' : '跟随新会话默认'),
        z('自定义后，只有选中的 channel 会在这个会话启动它的 MCP 服务器'),
        <Switch
          on={channelsCustom}
          label={z('自定义 channels')}
          onToggle={() => set({ channels: channelsCustom ? undefined : inherited })}
        />,
      )}
      {[...new Map(sources.channels.map(c => [c.plugin, c])).values()].map(c => {
        const entry = `plugin:${c.plugin}`
        return row(
          `c:${c.plugin}`,
          c.name,
          c.plugin,
          <Switch
            on={channelOn(entry)}
            label={c.name}
            onToggle={() => {
              // Turning one on or off makes the list this config's own.
              const list = value.channels ?? inherited
              set({ channels: list.includes(entry) ? list.filter(e => e !== entry) : [...list, entry] })
            }}
          />,
        )
      })}
      <div className="grp-h" style={{ marginTop: 10 }}>
        Hooks
      </div>
      {row(
        'h',
        z('在这个会话停用全部 hooks'),
        z('mods 也是 hooks，会一起停用'),
        <Switch
          on={value.hooks === false || (value.hooks === undefined && base.hooks === false)}
          label={z('在这个会话停用全部 hooks')}
          onToggle={() => set({ hooks: value.hooks === false ? undefined : false })}
        />,
      )}
    </>
  )
}

async function loadSources(control: ExtProps['control']): Promise<Sources> {
  const [plugins, mods, channels, mcp] = await Promise.all([
    ext.plugins(),
    ext.mods(),
    ext.channels(),
    control
      ? control({ subtype: 'mcp_status' })
          .then(b => (Array.isArray(b.mcpServers) ? (b.mcpServers as { name: string; status: string; channelDeferred?: boolean }[]) : []))
          .catch(() => [])
      : Promise.resolve([]),
  ])
  const channelServers = new Set(channels.map(c => c.server))
  return {
    plugins: plugins.installed.map(p => ({ id: p.id, on: p.on, description: p.description })),
    mods,
    channels,
    // Channel servers follow the Channels section; plugin servers follow their plugin.
    mcp: mcp
      .filter(s => !channelServers.has(s.name) && !s.name.startsWith('plugin:'))
      .map(s => ({ name: s.name, on: s.status !== 'disabled' })),
  }
}

/** Session config: this session's profile and own entries, and the profiles themselves. */
export function SessionConfigBody({ z, flash, control, sessionId }: ExtProps & { sessionId?: string }) {
  const [tab, setTab] = useState<'session' | 'profiles'>(sessionId ? 'session' : 'profiles')
  const [sources, setSources] = useState<Sources>()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [own, setOwn] = useState<{ profile_id: string | null; config: SessionConfig }>()
  const [editing, setEditing] = useState<{ id?: string; name: string; config: SessionConfig }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void (async () => {
      try {
        const [s, p, o] = await Promise.all([
          loadSources(control),
          sessionConfig.profiles(),
          sessionId ? sessionConfig.get(sessionId) : Promise.resolve(undefined),
        ])
        setSources(s)
        setProfiles(p)
        if (o) setOwn({ profile_id: o.profile_id, config: o.config })
      } catch (e) {
        setError(errorText(e))
      }
    })()
  }, [control, sessionId])
  if (error) return <p className="note">{error}</p>
  if (!sources) return <p className="note">{z('加载中…')}</p>

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (e) {
      flash(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const saveSession = () =>
    run(async () => {
      if (!sessionId || !own) return
      const { restart } = await sessionConfig.set(sessionId, own.profile_id, own.config)
      flash(
        z(
          restart === 'restarted'
            ? '已保存，会话正在用新配置重启'
            : restart === 'pending'
              ? '已保存，当前回合结束后会话会用新配置重启'
              : '已保存，下次打开会话时生效',
        ),
      )
    })
  const saveProfile = () =>
    run(async () => {
      if (!editing) return
      const saved = editing.id
        ? await sessionConfig.saveProfile(editing.id, editing.name, editing.config)
        : await sessionConfig.createProfile(editing.name, editing.config)
      setProfiles(await sessionConfig.profiles())
      setEditing({ id: saved.id, name: saved.name, config: saved.config })
      flash(z('模版已保存，使用它的运行中会话会重启'))
    })
  const deleteProfile = (id: string) =>
    run(async () => {
      await sessionConfig.deleteProfile(id)
      setProfiles(await sessionConfig.profiles())
      setEditing(undefined)
      if (own?.profile_id === id) setOwn({ ...own, profile_id: null })
    })
  const profileOf = (id: string | null | undefined) => profiles.find(p => p.id === id)

  return (
    <>
      <div className="settabs">
        <button type="button" data-dtab="session" aria-pressed={tab === 'session'} onClick={() => setTab('session')}>
          {z('本会话')}
        </button>
        <button type="button" data-dtab="profiles" aria-pressed={tab === 'profiles'} onClick={() => setTab('profiles')}>
          {z('模版')}
        </button>
      </div>
      {tab === 'session' &&
        (!sessionId || !own ? (
          <p className="note">{z('打开一个会话后才能配置它。')}</p>
        ) : (
          <>
            <div className="xrow">
              <div>
                <b>{z('模版')}</b>
                <small>{z('会话先用模版，再叠加下面单独调整的项')}</small>
              </div>
              <div className="acts">
                <Pick
                  id="sc-profile"
                  value={own.profile_id ?? ''}
                  options={[{ value: '', label: z('不用模版') }, ...profiles.map(p => ({ value: p.id, label: p.name }))]}
                  onChange={v => setOwn({ ...own, profile_id: v || null })}
                />
              </div>
            </div>
            <ConfigEditor
              z={z}
              value={own.config}
              base={profileOf(own.profile_id)?.config ?? {}}
              sources={sources}
              onChange={config => setOwn({ ...own, config })}
            />
            <div className="btns" style={{ marginTop: 12 }}>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing({ name: z('新模版'), config: { ...profileOf(own.profile_id)?.config, ...own.config } })
                  setTab('profiles')
                }}
              >
                {z('存为模版')}
              </button>
              <button className="btn primary" type="button" data-sc-save disabled={busy} onClick={() => void saveSession()}>
                {z('保存并应用')}
              </button>
            </div>
          </>
        ))}
      {tab === 'profiles' && (
        <>
          {profiles.map(p => (
            <div className="xrow" key={p.id}>
              <div>
                <b>{p.name}</b>
              </div>
              <div className="acts">
                <button className="btn" type="button" data-sc-edit={p.name} onClick={() => setEditing({ id: p.id, name: p.name, config: p.config })}>
                  {z('编辑')}
                </button>
                <button className="btn danger" type="button" disabled={busy} onClick={() => void deleteProfile(p.id)}>
                  {z('删除')}
                </button>
              </div>
            </div>
          ))}
          {!profiles.length && !editing && <p className="note">{z('还没有模版。')}</p>}
          {!editing && (
            <div className="btns" style={{ marginTop: 10 }}>
              <button className="btn" type="button" data-sc-new onClick={() => setEditing({ name: z('新模版'), config: {} })}>
                {z('新建模版')}
              </button>
            </div>
          )}
          {editing && (
            <>
              <div className="grp-h" style={{ marginTop: 12 }}>
                {z(editing.id ? '编辑模版' : '新建模版')}
              </div>
              <input
                className="scname"
                aria-label={z('模版名称')}
                data-sc-name
                value={editing.name}
                maxLength={100}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
              />
              <ConfigEditor z={z} value={editing.config} base={{}} sources={sources} onChange={config => setEditing({ ...editing, config })} />
              <div className="btns" style={{ marginTop: 12 }}>
                <button className="btn" type="button" onClick={() => setEditing(undefined)}>
                  {z('取消')}
                </button>
                <button
                  className="btn primary"
                  type="button"
                  data-sc-profile-save
                  disabled={busy || !editing.name.trim()}
                  onClick={() => void saveProfile()}
                >
                  {z('保存模版')}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
