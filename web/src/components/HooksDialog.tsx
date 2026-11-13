import { Fragment, useEffect, useState } from 'react'
import { ext, type HookRow } from '../extApi'
import { errorText, type ExtProps } from './extShared'

// Listed event groups follow this order; others come after.
const HOOK_EVENTS = [
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

/** Hooks by event, from settings files and plugins. Read-only, like the TUI's /hooks. */
export function HooksBody({ z }: ExtProps) {
  const [data, setData] = useState<{ disabled: boolean; hooks: HookRow[] }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    void ext.hooks().then(setData, e => setError(errorText(e)))
  }, [])
  if (error) return <p className="note">{error}</p>
  if (!data) return <p className="note">{z('加载中…')}</p>
  const events = [...new Set([...HOOK_EVENTS, ...data.hooks.map(h => h.event)])].filter(ev =>
    data.hooks.some(h => h.event === ev),
  )
  const off = data.disabled
  return (
    <>
      <p className="note" data-hooks-readonly>
        {z('此列表只读。要添加或修改 hook，请编辑 settings.json 或让 Claude 修改。')}
      </p>
      {off && <p className="note">{z('全部 hooks 已停用（disableAllHooks）')}</p>}
      {!data.hooks.length && <p className="note">{z('还没有 hook')}</p>}
      {events.map(ev => (
        <Fragment key={ev}>
          <div className="grp-h mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {ev}
          </div>
          {data.hooks
            .filter(h => h.event === ev)
            .map((h, i) => (
              <div className="xrow hookrow" key={`${h.source}-${i}`} style={off ? { opacity: 0.5 } : undefined}>
                <div>
                  <b className="mono">{h.matcher || z('全部')}</b> <span className="tag">{sourceTag(z, h)}</span>
                  <small>
                    <code>{h.command}</code>
                    {h.timeout !== undefined && ` · ${h.timeout}s`}
                  </small>
                </div>
              </div>
            ))}
        </Fragment>
      ))}
    </>
  )
}
