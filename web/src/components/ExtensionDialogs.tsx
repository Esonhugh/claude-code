import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { type ChannelPlugin, ext, type InstalledPlugin, type Marketplace, type MarketPlugin, type Mod } from '../extApi'
import { type Control, errorText, type ExtProps, Switch } from './extShared'

type McpServer = {
  name: string
  status: string
  transport?: string
  source?: string
  scope?: string
  tools?: unknown[]
  capabilities?: { experimental?: Record<string, unknown> }
}

const MCP_STATUS: Record<string, [string, string]> = {
  connected: ['completed', '已连接'],
  'needs-auth': ['idle', '需要登录'],
  failed: ['killed', '连接失败'],
  pending: ['idle', '连接中…'],
  connecting: ['idle', '连接中…'],
  disabled: ['idle', '已停用'],
}

async function mcpStatus(control: Control): Promise<McpServer[]> {
  const body = await control({ subtype: 'mcp_status' })
  return Array.isArray(body.mcpServers) ? (body.mcpServers as McpServer[]) : []
}

function mcpFrom(z: ExtProps['z'], s: McpServer): string {
  switch (s.source ?? s.scope) {
    case 'plugin':
      return `${z('插件')} ${s.name.split(':')[1] ?? s.name}`
    case 'user':
      return `${z('用户')} ~/.claude.json`
    case 'project':
      return `${z('项目')} .mcp.json`
    case 'local':
      return `${z('本地')} ~/.claude.json`
    case 'enterprise':
    case 'managed':
      return z('托管策略')
    case 'claudeai':
      return 'claude.ai'
    default:
      return s.source ?? s.scope ?? ''
  }
}

const isChannel = (s?: McpServer) => !!s?.capabilities?.experimental?.['claude/channel']
const canRelayApproval = (s?: McpServer) => !!s?.capabilities?.experimental?.['claude/channel/permission']

function NoSession({ z }: { z: ExtProps['z'] }) {
  return <p className="note">{z('打开一个运行中的会话后才能查看和管理 MCP 服务器。')}</p>
}

/** MCP servers of the open session, with login (OAuth in a new tab), reconnect and on/off. */
export function McpBody({ z, flash, control }: ExtProps) {
  const [servers, setServers] = useState<McpServer[]>()
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string>()
  const alive = useRef(true)
  const refresh = () =>
    control
      ? mcpStatus(control).then(
          s => alive.current && setServers(s),
          e => alive.current && setError(errorText(e)),
        )
      : Promise.resolve()
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [control])
  if (!control) return <NoSession z={z} />
  if (error) return <p className="note">{error}</p>
  if (!servers) return <p className="note">{z('加载中…')}</p>
  if (!servers.length) return <p className="note">{z('还没有配置 MCP 服务器。')}</p>

  const mark = (name: string, on: boolean) => setBusy(b => ({ ...b, [name]: on }))
  const waitConnected = async (name: string) => {
    for (let i = 0; i < 60 && alive.current; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const next = await mcpStatus(control).catch(() => undefined)
      if (!next || !alive.current) continue
      setServers(next)
      if (next.find(s => s.name === name)?.status === 'connected') {
        flash(z(`${name} 已连接`))
        return
      }
    }
  }
  const login = async (name: string) => {
    // Opened inside the click so the browser allows it; pointed at the login page once known.
    const tab = window.open('about:blank', '_blank')
    mark(name, true)
    try {
      const body = await control({ subtype: 'mcp_authenticate', serverName: name })
      const url = typeof body.authUrl === 'string' && /^https?:\/\//.test(body.authUrl) ? body.authUrl : undefined
      if (url && tab) {
        tab.opener = null
        tab.location.href = url
        flash(z(`已在新标签页打开 ${name} 的登录页`))
      } else {
        tab?.close()
      }
      await waitConnected(name)
    } catch (e) {
      tab?.close()
      flash(errorText(e))
    } finally {
      mark(name, false)
    }
  }
  const act = async (name: string, body: Record<string, unknown>, done: string) => {
    mark(name, true)
    try {
      await control(body)
      flash(z(done))
    } catch (e) {
      flash(errorText(e))
    } finally {
      mark(name, false)
      await refresh()
    }
  }
  return (
    <div>
      {servers.map(x => {
        const st = busy[x.name] ? 'connecting' : x.status
        const [cls, label] = MCP_STATUS[st] ?? ['idle', st]
        const tools = x.tools?.length ?? 0
        return (
          <div className="xrow" key={x.name}>
            <div>
              <b className="mono">{x.source === 'plugin' ? x.name.split(':').at(-1) : x.name}</b>{' '}
              <span className="note">{x.transport ?? 'stdio'}</span>
              {isChannel(x) && (
                <>
                  {' '}
                  <span className="tag src-upload">{z(canRelayApproval(x) ? 'channel · 可转发审批' : 'channel')}</span>
                </>
              )}
              <small>
                {mcpFrom(z, x)}
                {tools > 0 && z(` · ${tools} 个工具`)}
              </small>
            </div>
            <div className="acts">
              <span className={`badge ${cls}`}>{z(label)}</span>
              {st === 'needs-auth' && (
                <button className="btn" type="button" data-mcp-auth={x.name} onClick={() => void login(x.name)}>
                  {z('登录')}
                </button>
              )}
              {st === 'failed' && (
                <button
                  className="btn"
                  type="button"
                  data-mcp-reconnect={x.name}
                  onClick={() => void act(x.name, { subtype: 'mcp_reconnect', serverName: x.name }, `${x.name} 已连接`)}
                >
                  {z('重连')}
                </button>
              )}
              {x.source !== 'sdk' && (
                <Switch
                  on={x.status !== 'disabled'}
                  label={z('启用')}
                  disabled={busy[x.name]}
                  onToggle={() => {
                    const on = x.status === 'disabled'
                    void act(x.name, { subtype: 'mcp_toggle', serverName: x.name, enabled: on }, on ? `已启用 ${x.name}` : `已停用 ${x.name}`)
                  }}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Channels: plugin MCP servers that push messages in; enable for this session or by default (`--channels`). */
export function ChannelsBody({ z, flash, control }: ExtProps) {
  const [channels, setChannels] = useState<ChannelPlugin[]>()
  const [market, setMarket] = useState<MarketPlugin[]>([])
  const [servers, setServers] = useState<McpServer[]>([])
  const [enabled, setEnabled] = useState<Partial<Record<string, 'enabling' | 'active'>>>({})
  const [installing, setInstalling] = useState<string>()
  const [error, setError] = useState<string>()
  const load = async () => {
    try {
      const [list, plugins] = await Promise.all([ext.channels(), ext.plugins()])
      setChannels(list)
      setMarket(plugins.discover.filter(p => p.channel))
      if (control) setServers(await mcpStatus(control).catch(() => []))
    } catch (e) {
      setError(errorText(e))
    }
  }
  useEffect(() => {
    void load()
  }, [control])
  if (error) return <p className="note">{error}</p>
  if (!channels) return <p className="note">{z('加载中…')}</p>

  const enable = async (c: ChannelPlugin) => {
    if (!control) return
    setEnabled(e => ({ ...e, [c.server]: 'enabling' }))
    try {
      await control({ subtype: 'channel_enable', serverName: c.server })
      setEnabled(e => ({ ...e, [c.server]: 'active' }))
      flash(z(`已在本会话启用 ${c.name}`))
    } catch (err) {
      setEnabled(e => {
        const next = { ...e }
        delete next[c.server]
        return next
      })
      flash(errorText(err))
    }
  }
  const setDefault = async (c: ChannelPlugin) => {
    try {
      await ext.setDefaultChannel(c.plugin, !c.def)
      await load()
      flash(z(!c.def ? `新会话会默认启用 ${c.name}` : `新会话不再默认启用 ${c.name}`))
    } catch (e) {
      flash(errorText(e))
    }
  }
  const install = async (m: MarketPlugin) => {
    setInstalling(m.id)
    try {
      await ext.plugin(m.id, 'install')
      await ext.setDefaultChannel(m.id, true)
      await control?.({ subtype: 'reload_plugins' }).catch(() => undefined)
      await load()
      flash(z('已重新加载插件'))
    } catch (e) {
      flash(errorText(e))
    } finally {
      setInstalling(undefined)
    }
  }
  return (
    <>
      {channels.map(c => {
        const server = servers.find(s => s.name === c.server)
        const connected = server?.status === 'connected'
        const st = enabled[c.server] ?? (connected && c.def ? 'active' : connected ? 'available' : 'off')
        const perm = canRelayApproval(server)
        const sub =
          st === 'active'
            ? perm
              ? z('可以远程批准权限请求')
              : ''
            : !c.pluginEnabled
              ? z('插件已停用')
              : !control
                ? z('打开一个运行中的会话后才能在本会话启用')
                : !connected
                  ? z('MCP 服务器未连接')
                  : perm
                    ? z('声明了审批能力，启用后权限请求也会推送过去')
                    : ''
        return (
          <div className="xrow" key={c.server}>
            <div>
              <b className="mono">{c.name}</b> <span className="note mono">{c.plugin}</span>
              <small>{sub}</small>
            </div>
            <div className="acts">
              {st === 'active' ? (
                <span className="badge completed">{z('本会话已启用')}</span>
              ) : st === 'enabling' ? (
                <span className="badge idle">{z('启用中…')}</span>
              ) : (
                <span className="badge idle">{z('未启用')}</span>
              )}
              {st === 'available' && (
                <button className="btn" type="button" data-ch-on={c.name} onClick={() => void enable(c)}>
                  {z('在本会话启用')}
                </button>
              )}
              <label className="note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Switch on={c.def} label={z('新会话默认启用')} onToggle={() => void setDefault(c)} />
                {z('新会话默认')}
              </label>
            </div>
          </div>
        )
      })}
      {!channels.length && <p className="note">{z('还没有安装提供 channel 的插件。')}</p>}
      {market.length > 0 && (
        <div className="grp-h" style={{ marginTop: 10 }}>
          {z('添加 channel')}
        </div>
      )}
      {market.map(m => (
        <div className="xrow" key={m.id}>
          <div>
            <b>{m.name}</b> <span className="note mono">@{m.marketplace}</span>
            <small>{m.description}</small>
          </div>
          <div className="acts">
            {m.installed ? (
              <span className="badge completed">{z('已安装')}</span>
            ) : (
              <button
                className="btn"
                type="button"
                data-ch-install={m.id}
                disabled={installing === m.id}
                onClick={() => void install(m)}
              >
                {z(installing === m.id ? '安装中…' : '安装并启用')}
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  )
}

const PART_LABELS: Record<string, [string, string]> = {
  skills: ['skill', 'skills'],
  commands: ['command', 'commands'],
  agents: ['agent', 'agents'],
  hooks: ['hook', 'hooks'],
  mcp: ['MCP', 'MCP'],
  mods: ['mod', 'mods'],
}

export function partTags(parts: Record<string, number>): string[] {
  return Object.entries(parts).map(([k, n]) => {
    const [one, many] = PART_LABELS[k] ?? [k, k]
    return `${n} ${n === 1 ? one : many}`
  })
}

function Tags({ list }: { list: string[] }) {
  if (!list.length) return null
  return (
    <span className="tags">
      {list.map(t => (
        <span className="tag" key={t}>
          {t}
        </span>
      ))}
    </span>
  )
}

/** Plugins: installed / discover / marketplaces, through the same operations as `claude plugin`. */
export function PluginsBody({ z, flash, control }: ExtProps) {
  const [tab, setTab] = useState<'installed' | 'discover' | 'markets'>('installed')
  const [data, setData] = useState<{ installed: InstalledPlugin[]; discover: MarketPlugin[]; marketplaces: Marketplace[] }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const load = () => ext.plugins().then(setData, e => setError(errorText(e)))
  useEffect(() => {
    void load()
  }, [])
  const run = async (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key)
    try {
      await action()
      await load()
      await control?.({ subtype: 'reload_plugins' }).catch(() => undefined)
      flash(z(done ?? '已重新加载插件'))
    } catch (e) {
      flash(errorText(e))
    } finally {
      setBusy(undefined)
    }
  }
  const tabs = [
    ['installed', '已安装'],
    ['discover', '发现'],
    ['markets', '市场源'],
  ] as const
  let rows: ReactNode = null
  if (error) rows = <p className="note">{error}</p>
  else if (!data) rows = <p className="note">{z('加载中…')}</p>
  else if (tab === 'installed') {
    rows = (
      <>
        {data.installed.map(x => (
          <div className="xrow" key={x.id}>
            <div>
              <b>{x.name}</b>{' '}
              <span className="note mono">
                {x.marketplace && `@${x.marketplace}`}
                {x.version && `${x.marketplace ? ' · ' : ''}v${x.version}`}
              </span>
              <small>{x.description}</small>
              <Tags list={partTags(x.parts)} />
            </div>
            <div className="acts">
              {x.update && (
                <button className="btn" type="button" data-plug-update={x.id} disabled={!!busy} onClick={() => void run(x.id, () => ext.plugin(x.id, 'update'))}>
                  {z(`更新到 v${x.update}`)}
                </button>
              )}
              <button className="btn" type="button" data-plug-remove={x.id} disabled={!!busy} onClick={() => void run(x.id, () => ext.plugin(x.id, 'uninstall'))}>
                {z('卸载')}
              </button>
              <Switch
                on={x.on}
                label={z('启用')}
                disabled={!!busy}
                onToggle={() => void run(x.id, () => ext.plugin(x.id, x.on ? 'disable' : 'enable'))}
              />
            </div>
          </div>
        ))}
        {!data.installed.length && <p className="note">{z('还没有安装插件。')}</p>}
        <div className="applist">
          <div className="grp-h">{z('ChatGPT 应用（Codex apps）')}</div>
          <p className="note">{z('用 ChatGPT 账号登录后，这里会列出你在 ChatGPT 里连好的应用；API key 用不了。')}</p>
        </div>
      </>
    )
  } else if (tab === 'discover') {
    const q = query.trim().toLowerCase()
    rows = (
      <>
        <div className="memsearch" style={{ marginBottom: 6 }}>
          <input id="plug-q" placeholder={z('搜索插件市场')} autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {data.discover
          .filter(x => !q || `${x.name} ${x.description}`.toLowerCase().includes(q))
          .map(x => (
            <div className="xrow" key={x.id}>
              <div>
                <b>{x.name}</b> <span className="note mono">@{x.marketplace}</span>
                <small>{x.description}</small>
              </div>
              <div className="acts">
                {x.installed ? (
                  <span className="badge completed">{z('已安装')}</span>
                ) : (
                  <button
                    className="btn primary"
                    type="button"
                    data-plug-install={x.id}
                    disabled={!!busy}
                    onClick={() => void run(x.id, () => ext.plugin(x.id, 'install'))}
                  >
                    {z(busy === x.id ? '安装中…' : '安装')}
                  </button>
                )}
              </div>
            </div>
          ))}
        {!data.discover.length && <p className="note">{z('市场源里还没有插件。')}</p>}
      </>
    )
  } else {
    const add = (e: FormEvent) => {
      e.preventDefault()
      const value = source.trim()
      if (!value) return
      void run('mk-add', async () => {
        await ext.addMarketplace(value)
        setSource('')
      }, '已添加市场源')
    }
    rows = (
      <>
        {data.marketplaces.map(m => (
          <div className="xrow" key={m.name}>
            <div>
              <b>{m.name}</b> {m.official && <span className="badge completed">{z('官方')}</span>}
              <small className="mono">{m.url}</small>
            </div>
            <div className="acts">
              <button
                className="btn"
                type="button"
                data-mk-refresh={m.name}
                disabled={!!busy}
                onClick={() => void run(m.name, () => ext.marketplace(m.name, 'refresh'), `已刷新 ${m.name}`)}
              >
                {z('刷新')}
              </button>
              {!m.official && (
                <button
                  className="btn"
                  type="button"
                  data-mk-remove={m.name}
                  disabled={!!busy}
                  onClick={() => void run(m.name, () => ext.marketplace(m.name, 'remove'), `已移除 ${m.name}`)}
                >
                  {z('移除')}
                </button>
              )}
            </div>
          </div>
        ))}
        <form className="memsearch" id="mk-add" style={{ marginTop: 8 }} onSubmit={add}>
          <input
            id="mk-src"
            placeholder={z('添加市场源：owner/repo 或 git URL')}
            autoComplete="off"
            required
            value={source}
            onChange={e => setSource(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!!busy}>
            {z(busy === 'mk-add' ? '添加中…' : '添加')}
          </button>
        </form>
      </>
    )
  }
  return (
    <>
      <div className="settabs">
        {tabs.map(([k, l]) => (
          <button type="button" key={k} data-plugtab={k} aria-pressed={k === tab} onClick={() => setTab(k)}>
            {z(l)}
          </button>
        ))}
      </div>
      <div>{rows}</div>
    </>
  )
}

const SURFACES: Record<string, string> = { Pane: '右侧面板' }

/** Mods: plugins with hook modules; on/off, reload, and the entry module's source. */
export function ModsBody({ z, flash, control }: ExtProps) {
  const [mods, setMods] = useState<Mod[]>()
  const [error, setError] = useState<string>()
  const [edit, setEdit] = useState<{ mod: Mod; source: string }>()
  const [busy, setBusy] = useState(false)
  const load = () => ext.mods().then(setMods, e => setError(errorText(e)))
  useEffect(() => {
    void load()
  }, [])
  if (error) return <p className="note">{error}</p>
  if (!mods) return <p className="note">{z('加载中…')}</p>
  const reload = () => control?.({ subtype: 'reload_plugins' }).catch(() => undefined)
  if (edit) {
    const m = edit.mod
    const save = async () => {
      setBusy(true)
      try {
        await ext.saveModSource(m.id, edit.source)
        await reload()
        setEdit(undefined)
        await load()
        flash(z(`已保存并重新加载 ${m.id}`))
      } catch (e) {
        flash(errorText(e))
      } finally {
        setBusy(false)
      }
    }
    return (
      <>
        <div className="xrow" style={{ border: 0, paddingTop: 0 }}>
          <div>
            <b className="mono">{m.id}</b>
            <small>
              {m.plugin} · {m.file}
            </small>
          </div>
        </div>
        <textarea
          className="modsrc"
          id="mod-src"
          spellCheck={false}
          readOnly={!m.editable}
          value={edit.source}
          onChange={e => setEdit({ mod: m, source: e.target.value })}
        />
        <div className="btns">
          <button className="btn" type="button" data-mod-cancel onClick={() => setEdit(undefined)}>
            {z('取消')}
          </button>
          <button className="btn primary" type="button" data-mod-save={m.id} disabled={!m.editable || busy} onClick={() => void save()}>
            {z('保存并重新加载')}
          </button>
        </div>
      </>
    )
  }
  const open = async (m: Mod) => {
    try {
      setEdit({ mod: m, source: (await ext.modSource(m.id)).source })
    } catch (e) {
      flash(errorText(e))
    }
  }
  return (
    <>
      {mods.map(m => (
        <div className="xrow" key={m.plugin}>
          <div>
            <b className="mono">{m.id}</b> <span className="note mono">{m.plugin}</span>
            <small>{m.description}</small>
            {(m.surfaces.length > 0 || m.events.length > 0) && (
              <small>
                {m.surfaces.length > 0 && `${z('界面：')}${m.surfaces.map(s => z(SURFACES[s] ?? s)).join(z('、'))}`}
                {m.surfaces.length > 0 && m.events.length > 0 && ' · '}
                {m.events.length > 0 && (
                  <>
                    {z('事件：')}
                    <span className="mono">{m.events.join(', ')}</span>
                  </>
                )}
              </small>
            )}
          </div>
          <div className="acts">
            <button className="btn" type="button" data-mod-edit={m.id} onClick={() => void open(m)}>
              {z('编辑')}
            </button>
            <button
              className="btn"
              type="button"
              data-mod-reload={m.id}
              onClick={async () => {
                await reload()
                flash(z(`已重新加载 ${m.id}`))
              }}
            >
              {z('重新加载')}
            </button>
            <Switch
              on={m.on}
              label={z('启用')}
              onToggle={async () => {
                try {
                  await ext.setMod(m.id, !m.on)
                  await load()
                  await reload()
                  flash(z(!m.on ? `已启用 ${m.id}` : `已停用 ${m.id}`))
                } catch (e) {
                  flash(errorText(e))
                }
              }}
            />
          </div>
        </div>
      ))}
      {!mods.length && <p className="note">{z('还没有安装 mod。')}</p>}
    </>
  )
}
