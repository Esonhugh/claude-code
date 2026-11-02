import { type FormEvent, Fragment, useEffect, useRef, useState } from 'react'
import { ext, type HookInput, type HookRow } from '../extApi'
import { errorText, type ExtProps, Switch } from './extShared'
import { FootMenu } from './ui'

// The events the prototype's form offers, in its order; listed groups follow it too.
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'PreCompact',
]

function sourceTag(z: ExtProps['z'], h: HookRow): string {
  switch (h.source) {
    case 'user':
      return `${z('用户')} ${h.label}`
    case 'project':
      return `${z('项目')} .claude/settings.json`
    case 'local':
      return `${z('本地')} .claude/settings.local.json`
    case 'plugin':
      return `${z('插件')} ${h.label}`
    case 'policy':
      return z('托管策略')
  }
}

/** A popover in place of the prototype's native <select>. */
function Pick<V extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string
  value: V
  options: { value: V; label: string }[]
  onChange: (v: V) => void
}) {
  return (
    <FootMenu
      menuClass="pop footmenu pickmenu"
      buttonProps={{ id }}
      button={
        <>
          <span>{options.find(o => o.value === value)?.label ?? value}</span>
          <span aria-hidden="true">▾</span>
        </>
      }
    >
      {close =>
        options.map(o => (
          <button
            type="button"
            role="menuitemradio"
            key={o.value}
            aria-checked={o.value === value}
            onClick={() => {
              onChange(o.value)
              close()
            }}
          >
            {o.label}
          </button>
        ))
      }
    </FootMenu>
  )
}

function HookForm({
  z,
  initial,
  onCancel,
  onSave,
}: {
  z: ExtProps['z']
  initial: HookInput
  onCancel: () => void
  onSave: (hook: HookInput) => Promise<void>
}) {
  const [hook, setHook] = useState(initial)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const form = formRef.current
    const body = form?.closest<HTMLElement>('.body')
    if (form && body) body.scrollTop += Math.max(0, form.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 14)
  }, [])
  const set = (patch: Partial<HookInput>) => setHook({ ...hook, ...patch })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await onSave({ ...hook, command: hook.command.trim() })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="hookform" id="hook-form" ref={formRef} onSubmit={e => void submit(e)}>
      <label htmlFor="hk-event">{z('事件')}</label>
      <Pick
        id="hk-event"
        value={hook.event}
        options={[...new Set([...HOOK_EVENTS, hook.event])].map(ev => ({ value: ev, label: ev }))}
        onChange={event => set({ event })}
      />
      <label htmlFor="hk-matcher">{z('匹配')}</label>
      <input
        id="hk-matcher"
        className="mono"
        value={hook.matcher}
        placeholder={z('工具名，例如 Bash 或 Write|Edit；留空匹配全部')}
        onChange={e => set({ matcher: e.target.value })}
      />
      <label htmlFor="hk-cmd">{z('命令')}</label>
      <input id="hk-cmd" className="mono" value={hook.command} required onChange={e => set({ command: e.target.value })} />
      <label htmlFor="hk-timeout">{z('超时（秒）')}</label>
      <input
        id="hk-timeout"
        type="number"
        min={1}
        max={600}
        value={hook.timeout ?? ''}
        onChange={e => set({ timeout: e.target.value ? Number(e.target.value) : undefined })}
      />
      <label htmlFor="hk-src">{z('写入')}</label>
      <Pick
        id="hk-src"
        value={hook.source}
        options={[
          { value: 'user', label: z('用户设置') },
          { value: 'project', label: z('项目设置') },
        ]}
        onChange={source => set({ source })}
      />
      <div className="btns">
        <button className="btn" type="button" data-hook-cancel onClick={onCancel}>
          {z('取消')}
        </button>
        <button className="btn primary" type="submit" disabled={busy}>
          {z('保存')}
        </button>
      </div>
    </form>
  )
}

/** Hooks by event, from settings files and plugins; user and project hooks can be edited. */
export function HooksBody({ z, flash }: ExtProps) {
  const [data, setData] = useState<{ disabled: boolean; hooks: HookRow[] }>()
  const [error, setError] = useState<string>()
  const [edit, setEdit] = useState<HookRow | 'new'>()
  const load = () => ext.hooks().then(setData, e => setError(errorText(e)))
  useEffect(() => {
    void load()
  }, [])
  if (error) return <p className="note">{error}</p>
  if (!data) return <p className="note">{z('加载中…')}</p>
  const run = async (action: () => Promise<void>, done: string) => {
    try {
      await action()
      await load()
      flash(z(done))
      return true
    } catch (e) {
      flash(errorText(e))
      return false
    }
  }
  const events = [...new Set([...HOOK_EVENTS, ...data.hooks.map(h => h.event)])].filter(ev =>
    data.hooks.some(h => h.event === ev),
  )
  const off = data.disabled
  const initial: HookInput =
    edit && edit !== 'new'
      ? {
          event: edit.event,
          matcher: edit.matcher,
          command: edit.command,
          timeout: edit.timeout,
          source: edit.source === 'project' ? 'project' : 'user',
        }
      : { event: 'PreToolUse', matcher: '', command: '', timeout: 60, source: 'user' }
  return (
    <>
      <div className="setrow" style={{ border: 0, paddingTop: 0 }}>
        <div>
          <b>{z('停用全部 hooks')}</b>
          <small>{z('临时关掉所有 hook，配置保留')}</small>
        </div>
        <Switch
          on={off}
          label={z('停用全部 hooks')}
          onToggle={() => void run(() => ext.setHooksDisabled(!off), off ? '已启用 hooks' : '已停用全部 hooks')}
        />
      </div>
      {events.map(ev => (
        <Fragment key={ev}>
          <div className="grp-h mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {ev}
          </div>
          {data.hooks
            .filter(h => h.event === ev)
            .map((h, i) => (
              <div className="xrow hookrow" key={h.id ?? `${h.source}-${i}`} style={off ? { opacity: 0.5 } : undefined}>
                <div>
                  <b className="mono">{h.matcher || z('全部')}</b> <span className="tag">{sourceTag(z, h)}</span>
                  <small>
                    <code>{h.command}</code>
                    {h.timeout !== undefined && ` · ${h.timeout}s`}
                  </small>
                </div>
                <div className="acts">
                  {h.id && (h.source === 'user' || h.source === 'project') ? (
                    <>
                      <button className="btn" type="button" data-hook-edit={h.id} onClick={() => setEdit(h)}>
                        {z('编辑')}
                      </button>
                      <button
                        className="btn"
                        type="button"
                        data-hook-del={h.id}
                        onClick={() => void run(() => ext.deleteHook(h.id!), '已删除 hook')}
                      >
                        {z('删除')}
                      </button>
                    </>
                  ) : (
                    <span className="note">{z('只读')}</span>
                  )}
                </div>
              </div>
            ))}
        </Fragment>
      ))}
      {edit ? (
        <HookForm
          key={edit === 'new' ? 'new' : edit.id}
          z={z}
          initial={initial}
          onCancel={() => setEdit(undefined)}
          onSave={async hook => {
            const target = edit
            const ok = await run(
              () => (target === 'new' ? ext.addHook(hook) : ext.updateHook(target.id!, hook)),
              '已保存 hook',
            )
            if (ok) setEdit(undefined)
          }}
        />
      ) : (
        <div className="btns">
          <button className="btn" type="button" data-hook-new onClick={() => setEdit('new')}>
            {z('添加 hook')}
          </button>
        </div>
      )}
    </>
  )
}
