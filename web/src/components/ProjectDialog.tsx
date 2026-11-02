import { type FormEvent, useState } from 'react'
import { createProject, NeedsTrustError, patchProject, type Project } from '../api'
import { tilde } from '../files'
import { Dialog } from './Dialog'
import type { T } from './ui'

/** The task default model choices; null inherits the coordinator's model (CLAUDE_CODE_SUBAGENT_MODEL unset). */
export const WORKER_MODELS: { value: string | null; label: string }[] = [
  { value: null, label: '' },
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 5.5' },
]

/** New project (no `project`) or its settings: the prototype's `pjForm`. */
export function ProjectDialog({
  t,
  project,
  workspace,
  onSaved,
  onClose,
}: {
  t: T
  project?: Project
  workspace?: string
  onSaved: (project: Project) => void
  onClose: () => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [cwd, setCwd] = useState(() => tilde(workspace ?? '~'))
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [workerModel, setWorkerModel] = useState<string | null>(project?.worker_model ?? null)
  const [trustDir, setTrustDir] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const save = async (trust = false) => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const fields = { name: name.trim(), instructions: instructions.trim(), worker_model: workerModel }
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
          <div className="seg" role="radiogroup" aria-label={t('workerModel')}>
            {WORKER_MODELS.map(m => (
              <button
                type="button"
                role="radio"
                key={m.label}
                aria-checked={workerModel === m.value}
                onClick={() => setWorkerModel(m.value)}
              >
                {m.label || t('inheritModel')}
              </button>
            ))}
          </div>
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
