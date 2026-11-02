import { Fragment, useEffect, useState } from 'react'
import { ext, type Skill } from '../extApi'
import { errorText, type ExtProps, Switch } from './extShared'

const GROUPS: [Skill['group'], string][] = [
  ['project', '项目'],
  ['user', '用户'],
  ['plugin', '插件'],
  ['builtin', '内置'],
]

/** Skills: search, groups by source, SKILL.md preview, on/off, "在对话中使用". */
export function SkillsBody({ z, flash, control, onUse }: ExtProps & { onUse: (name: string) => void }) {
  const [skills, setSkills] = useState<Skill[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string>()
  const [content, setContent] = useState<Record<string, string>>({})
  const load = () => ext.skills().then(setSkills, e => setError(errorText(e)))
  useEffect(() => {
    void load()
  }, [])
  const q = query.trim().toLowerCase()
  const hits = (skills ?? []).filter(x => !q || (x.display + x.description + x.where).toLowerCase().includes(q))
  const ordered = GROUPS.flatMap(([g]) => hits.filter(x => x.group === g))
  const current = ordered.find(x => x.name === open) ?? ordered[0]
  useEffect(() => {
    if (!current || current.name in content) return
    ext.skillContent(current.name).then(
      r => setContent(c => ({ ...c, [current.name]: r.content })),
      () => setContent(c => ({ ...c, [current.name]: '' })),
    )
  }, [current?.name])
  if (error) return <p className="note">{error}</p>
  const toggle = async (skill: Skill) => {
    try {
      await ext.setSkill(skill.name, !skill.on)
      await load()
      await control?.({ subtype: 'reload_skills' }).catch(() => undefined)
      flash(z('已重新加载 skills'))
    } catch (e) {
      flash(errorText(e))
    }
  }
  const groups = GROUPS.map(([g, label]) => [label, hits.filter(x => x.group === g)] as const).filter(([, l]) => l.length)
  const preview = (m: Skill) =>
    content[m.name] ||
    `---\nname: ${m.display}\ndescription: ${m.description}\n---\n${z(m.group === 'plugin' ? '由插件提供，随插件更新；要修改请复制到 ~/.claude/skills。' : '内置 skill，不能编辑。')}`
  return (
    <>
      <div className="memsearch">
        <label htmlFor="skill-q" hidden>
          {z('搜索 skill')}
        </label>
        <input
          id="skill-q"
          placeholder={z('搜索 skill')}
          value={query}
          autoComplete="off"
          autoFocus
          onChange={e => setQuery(e.target.value)}
        />
        <span className="note">{z(`${hits.filter(x => x.on).length} 个启用 / ${skills?.length ?? 0}`)}</span>
      </div>
      <div className="memgrid">
        <div className="memlist">
          {groups.map(([label, list]) => (
            <Fragment key={label}>
              <div className="grp-h">{z(label)}</div>
              {list.map(x => (
                <button
                  type="button"
                  key={`${x.group}:${x.name}`}
                  data-skill={x.name}
                  aria-current={x.name === current?.name}
                  style={x.on ? undefined : { opacity: 0.55 }}
                  onClick={() => setOpen(x.name)}
                >
                  /{x.display}
                  <small>{x.description}</small>
                </button>
              ))}
            </Fragment>
          ))}
          {skills && !groups.length && (
            <p className="note" style={{ padding: '6px 8px' }}>
              {z('没有匹配的 skill。')}
            </p>
          )}
        </div>
        {current && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <div className="xrow" style={{ border: 0, padding: 0 }}>
              <div>
                <b className="mono">/{current.display}</b>
                <small>{current.where || z('内置')}</small>
              </div>
              <div className="acts">
                <Switch
                  on={current.on}
                  label={z('启用')}
                  disabled={!current.toggleable}
                  title={current.toggleable ? undefined : z('随插件启用或停用')}
                  onToggle={() => void toggle(current)}
                />
                <button className="btn primary" type="button" disabled={!current.on} onClick={() => onUse(current.display)}>
                  {z('在对话中使用')}
                </button>
              </div>
            </div>
            <pre className="memview">{preview(current)}</pre>
          </div>
        )}
      </div>
    </>
  )
}
