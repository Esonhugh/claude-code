import { type FormEvent, useState } from 'react'
import { createProject, NeedsTrustError, patchProject, type Project } from '../api'
import { tilde } from '../files'
import type { ModelOption } from '../protocol'
import { effortChoices, shownModels } from './Composer'
import { Dialog } from './Dialog'
import { FootMenu, type T } from './ui'

/** The task default model choices; null inherits the coordinator's model (CLAUDE_CODE_SUBAGENT_MODEL unset). */
export const WORKER_MODELS: { value: string | null; label: string }[] = [
  { value: null, label: '' },
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 5.5' },
]

/**
 * The task model choices: inherit, then the models the sessions report (discovered gateway and
 * provider models included), or the built-in three before any session has reported; the saved
 * value stays listed even when the list no longer has it.
 */
export function workerModelChoices(models: ModelOption[], current: string | null): { value: string | null; label: string }[] {
  const listed = models.filter(m => m.value !== 'default').map(m => ({ value: m.value as string | null, label: m.displayName }))
  const choices = [WORKER_MODELS[0]!, ...(listed.length ? listed : WORKER_MODELS.slice(1))]
  return current && !choices.some(c => c.value === current) ? [...choices, { value: current, label: current }] : choices
}

/**
 * The task default menu: its model rows before "More models", how many that hides, and the effort
 * row (null is inherit). Inherit means the coordinator's model, so that model stays listed and its
 * effort levels are offered.
 */
export function taskDefaultMenu(
  models: ModelOption[],
  workerModel: string | null,
  workerEffort: string | null,
  inheritModel: string | undefined,
  expanded: boolean,
): { shown: { value: string | null; label: string }[]; hidden: number; efforts: (string | null)[] } {
  const choices = workerModelChoices(models, workerModel)
  const listed = models.filter(m => m.value !== 'default')
  const picked = workerModel ?? inheritModel
  const shownValues = new Set(shownModels(listed, picked, expanded).map(m => m.value))
  const shown = choices.filter(c => c.value === null || !listed.length || shownValues.has(c.value) || c.value === workerModel)
  return {
    shown,
    hidden: choices.length - shown.length,
    efforts: [null, ...effortChoices(picked, models, workerEffort ?? undefined)],
  }
}

/** New project (no `project`) or its settings: the prototype's `pjForm`. */
export function ProjectDialog({
  t,
  project,
  workspace,
  models,
  inheritModel,
  onSaved,
  onClose,
}: {
  t: T
  project?: Project
  workspace?: string
  models: ModelOption[]
  /** The coordinator's model, which "inherit" means: its row stays listed and its effort levels are offered. */
  inheritModel?: string
  onSaved: (project: Project) => void
  onClose: () => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [cwd, setCwd] = useState(() => tilde(workspace ?? '~'))
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [workerModel, setWorkerModel] = useState<string | null>(project?.worker_model ?? null)
  const choices = workerModelChoices(models, workerModel)
  const [workerEffort, setWorkerEffort] = useState<string | null>(project?.worker_effort ?? null)
  const [moreModels, setMoreModels] = useState(false)
  const menu = taskDefaultMenu(models, workerModel, workerEffort, inheritModel, moreModels)
  const [trustDir, setTrustDir] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const save = async (trust = false) => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const fields = { name: name.trim(), instructions: instructions.trim(), worker_model: workerModel, worker_effort: workerEffort }
      onSaved(
        project
          ? await patchProject(project.id, fields)
          : await createProject({ ...fields, cwd: cwd.trim(), ...(trust && { trust }) }),
      )
    } catch (err) {
      if (err instanceof NeedsTrustError) setTrustDir(err.directory)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save()
  }
  return (
    <Dialog t={t} title={project ? t('projectSettings') : t('newProject')} onClose={onClose}>
      <form className="pjform" id="pj-form" onSubmit={submit}>
        <div className="setrow">
          <div>
            <b>{t('projectName')}</b>
          </div>
          <input
            id="pj-name"
            value={name}
            required
            autoFocus={!project}
            style={{ width: 240 }}
            aria-label={t('projectName')}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div className="setrow">
          <div>
            <b>{t('projectFolder')}</b>
            <small>{t('projectFolderHint')}</small>
          </div>
          {project ? (
            <span className="mono">{tilde(project.cwd)}</span>
          ) : (
            <input
              id="pj-path"
              className="mono"
              value={cwd}
              required
              style={{ width: 240 }}
              aria-label={t('projectFolder')}
              onChange={e => {
                setCwd(e.target.value)
                setTrustDir(undefined)
              }}
            />
          )}
        </div>
        <div className="setrow col">
          <div>
            <b>{t('projectInstructions')}</b>
            <small>{t('projectInstructionsHint')}</small>
          </div>
          <textarea
            id="pj-instr"
            value={instructions}
            aria-label={t('projectInstructions')}
            onChange={e => setInstructions(e.target.value)}
          />
        </div>
        <div className="setrow">
          <div>
            <b>{t('workerModel')}</b>
            <small>{t('workerModelHint')}</small>
          </div>
          <FootMenu
            right
            fixed
            label={t('workerModel')}
            buttonClass="pj-model"
            button={
              <>
                {choices.find(c => c.value === workerModel)?.label || t('inheritModel')}
                {workerEffort && ` · ${workerEffort}`} <span aria-hidden="true">▾</span>
              </>
            }
          >
            {close => (
              <>
                {menu.shown.map(m => (
                <button
                  type="button"
                  role="menuitemradio"
                  key={m.value ?? ''}
                  aria-checked={workerModel === m.value}
                  onClick={() => {
                    setWorkerModel(m.value)
                    close()
                  }}
                >
                  {m.label || t('inheritModel')}
                </button>
                ))}
                {menu.hidden > 0 && (
                  <button type="button" className="mm-more" onClick={() => setMoreModels(true)}>
                    {t('moreModels', { n: String(menu.hidden) })} <span aria-hidden="true">›</span>
                  </button>
                )}
                <div className="mm-effort">
                  <div className="mh">{t('effort')}</div>
                  <div className="seg" role="radiogroup" aria-label={t('effort')}>
                    {menu.efforts.map(level => (
                      <button
                        type="button"
                        role="radio"
                        key={level ?? ''}
                        aria-checked={workerEffort === level}
                        onClick={() => setWorkerEffort(level)}
                      >
                        {level ?? t('inheritModel')}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </FootMenu>
        </div>
        {trustDir && (
          <div className="gate" role="alertdialog" aria-label={t('trustTitle')}>
            <b>{t('trustTitle')}</b>
            <span className="note">{t('trustNote', { dir: tilde(trustDir) })}</span>
            <div className="gopts">
              <button className="btn primary" type="button" onClick={() => void save(true)}>
                {t('trustAccept')}
              </button>
              <button className="btn" type="button" onClick={() => setTrustDir(undefined)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="note" role="alert">
            {error}
          </p>
        )}
        <div className="btns">
          <button className="btn primary" type="submit" disabled={busy}>
            {project ? t('save') : t('createProject')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
