import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { filterCommands, moveSelection, paletteQuery, type SlashCommand } from '../commands'
import { formatBytes } from '../files'
import type { Approval, ApprovalChoice, ModelOption } from '../protocol'
import { toolSummary } from '../tools'
import { modelName, modelOption } from './Message'
import { FootMenu, MODES, modeOf, SendIcon, type T } from './ui'

const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** `Opus 5.5 · high`: the model button's label. */
export function modelButtonLabel(
  model: string | undefined,
  effort: string | undefined,
  models: ModelOption[],
  t: T,
): string {
  // `default` is named by the model it resolves to, like the prototype's `Opus 5.5 · high`.
  const resolved =
    !model || model === 'default' ? (models.find(m => m.value === 'default')?.resolvedModel ?? model) : model
  const name = modelName(resolved, models) ?? t('model')
  return effort ? `${name} · ${effort}` : name
}

/** The description without the leading model name and the prices: `Best for everyday, complex tasks`. */
function modelHint(m: ModelOption): string | undefined {
  const parts = (m.description ?? '').split(' · ')
  if (parts[0]?.startsWith(`${m.displayName} `)) parts.shift()
  return parts.filter(p => p && !p.startsWith('$')).join(' · ') || undefined
}

/** Model list and effort levels, the prototype's `#model-menu`. */
export function ModelMenu({
  t,
  model,
  effort,
  models,
  onModel,
  onEffort,
  close,
}: {
  t: T
  model: string | undefined
  effort: string | undefined
  models: ModelOption[]
  onModel: (value: string) => void
  onEffort?: (level: string) => void
  close: () => void
}) {
  const current = modelOption(model, models)
  const levels = (current ?? models.find(m => m.value === 'default'))?.effortLevels ?? FALLBACK_EFFORTS
  return (
    <>
      <div className="mh">{t('modelGroup')}</div>
      {models.map(m => (
        <button
          type="button"
          role="menuitemradio"
          key={m.value}
          aria-checked={current?.value === m.value}
          onClick={() => {
            onModel(m.value)
            close()
          }}
        >
          {modelName(m.value, models) ?? m.displayName}
          {modelHint(m) && <small>{modelHint(m)}</small>}
        </button>
      ))}
      {onEffort && (
        <>
          <div className="mh">{t('effort')}</div>
          <div className="seg" role="radiogroup" aria-label={t('effort')}>
            {levels.map(level => (
              <button
                type="button"
                role="radio"
                key={level}
                aria-checked={effort === level}
                onClick={() => onEffort(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/** The five permission modes with their marks and one-line descriptions. */
export function ModeItems({
  t,
  mode,
  onMode,
  close,
}: {
  t: T
  mode: string
  onMode: (mode: string) => void
  close: () => void
}) {
  return (
    <>
      {MODES.map(m => (
        <button
          type="button"
          role="menuitemradio"
          key={m.key}
          aria-checked={mode === m.key}
          onClick={() => {
            onMode(m.key)
            close()
          }}
        >
          <span className="mono">{m.mark}</span>
          {m.label}
          <small>{t(m.desc)}</small>
        </button>
      ))}
    </>
  )
}

/** The `+` menu: files, images and the `/` skill palette. */
export function PlusMenu({
  t,
  className,
  onFiles,
  onImages,
  onSkill,
  skills,
}: {
  t: T
  className: string
  onFiles: () => void
  onImages: () => void
  onSkill: () => void
  skills: string[]
}) {
  return (
    <div className={`pop plusmenu ${className}`.trim()}>
      <button type="button" onClick={onFiles}>
        <span className="mono">F</span>
        <span>
          {t('uploadFile')}
          <small>{t('uploadFileHint')}</small>
        </span>
      </button>
      <button type="button" onClick={onImages}>
        <span className="mono">I</span>
        <span>
          {t('addImage')}
          <small>{t('addImageHint')}</small>
        </span>
      </button>
      <button type="button" onClick={onSkill}>
        <span className="mono">/</span>
        <span>
          {t('useSkill')}
          <small>{skills.length ? `${skills.slice(0, 3).join('、')}${skills.length > 3 ? '…' : ''}` : '/'}</small>
        </span>
      </button>
    </div>
  )
}

function Attachments({ t, files, setFiles }: { t: T; files: File[]; setFiles: (f: File[]) => void }) {
  if (!files.length) return null
  return (
    <div className="attachments">
      {files.map((file, i) => (
        <span className="att attachment" key={`${file.name}-${i}`}>
          <span className="kind">{(file.name.split('.').at(-1) ?? '').slice(0, 4).toUpperCase()}</span>
          <span>{file.name}</span>
          <small>{formatBytes(file.size)}</small>
          <button
            type="button"
            aria-label={t('removeAttachment', { name: file.name })}
            onClick={() => setFiles(files.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

/** Placeholder shortens on narrow screens, like the prototype's setPlaceholder. */
function usePlaceholder(t: T): string {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 560px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 560px)')
    const on = () => setNarrow(query.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [])
  return t(narrow ? 'composerPlaceholderShort' : 'composerPlaceholder')
}

/**
 * The input box shared by the chat and the start page: textarea, `/` palette,
 * attachments, `+` menu and the send (or stop) button. `start` draws the
 * prototype's `.wl-box`, otherwise `.cbox` with its `.crow` below.
 */
export function InputBox({
  t,
  start,
  busy,
  disabled,
  draft,
  setDraft,
  onSend,
  onStop,
  onFocus,
  files,
  setFiles,
  commands = [],
  hiddenCommands,
  skills = [],
  onShiftTab,
  crow,
}: {
  t: T
  start?: boolean
  busy: boolean
  disabled?: boolean
  draft: string
  setDraft: (v: string) => void
  onSend: () => void
  onStop: () => void
  onFocus?: () => void
  files: File[]
  setFiles: (files: File[]) => void
  commands?: SlashCommand[]
  hiddenCommands?: string[]
  skills?: string[]
  onShiftTab?: () => void
  /** The row under the box (chat only): gets the `+` button as its first child. */
  crow?: ReactNode
}) {
  const picker = useRef<HTMLInputElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const paletteId = useId()
  const chatPlaceholder = usePlaceholder(t)
  const [plusOpen, setPlusOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  // Esc closes the palette for this exact draft; typing reopens it.
  const [dismissed, setDismissed] = useState<string>()
  const query = dismissed === draft ? undefined : paletteQuery(draft)
  const matches = query === undefined ? [] : filterCommands(commands, query, hiddenCommands)
  const active = Math.min(selected, matches.length - 1)
  useEffect(() => {
    if (active >= 0) {
      document.getElementById(`${paletteId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, paletteId])
  useEffect(() => {
    if (!plusOpen) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.plusmenu, .plus')) setPlusOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [plusOpen])
  // Grow with the text up to the CSS max-height.
  useEffect(() => {
    const el = box.current
    if (!el || start) return
    el.style.height = ''
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft, start])
  const pick = (command: SlashCommand) => {
    setDraft(`/${command.name} `)
    setSelected(0)
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files]
    if (!pasted.length) return
    e.preventDefault()
    setFiles([...files, ...pasted])
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && !e.nativeEvent.isComposing) {
      const command = matches[active]!
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(moveSelection(active, e.key === 'ArrowDown' ? 1 : -1, matches.length))
        return
      }
      // Enter on a fully typed name sends it; otherwise it completes the name.
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        pick(command)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && draft !== `/${command.name}`) {
        e.preventDefault()
        pick(command)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(draft)
        return
      }
    }
    if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
      e.preventDefault()
      onShiftTab()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
    if (e.key === 'Escape' && busy) onStop()
  }
  const skillSet = new Set(skills)
  const palette = matches.length > 0 && (
    <div className="pop" id={paletteId} role="listbox" aria-label={t('completions')}>
      {matches.map((command, i) => {
        const isSkill = skillSet.has(command.name)
        const section = isSkill ? 'Skills' : t('commandsSection')
        const prev = matches[i - 1]
        const head =
          !query && (!prev || skillSet.has(prev.name) !== isSkill) ? (
            <div className="sec" key={`sec-${section}`}>
              {section}
            </div>
          ) : null
        return [
          head,
          <button
            type="button"
            key={command.name}
            id={`${paletteId}-${i}`}
            className="opt"
            role="option"
            aria-selected={i === active}
            // Keep focus in the textarea.
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => setSelected(i)}
            onClick={() => pick(command)}
          >
            <b>
              /{command.name}
              {command.argumentHint && <small> {command.argumentHint}</small>}
            </b>
            <span>
              {command.description}
              {command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''}
            </span>
            <em>{isSkill ? t('skillTag') : t('commandTag')}</em>
          </button>,
        ]
      })}
    </div>
  )
  const plus = (
    <button
      type="button"
      className="plus"
      aria-label={t('addFileOrSkill')}
      aria-expanded={plusOpen}
      disabled={disabled}
      onClick={() => setPlusOpen(!plusOpen)}
    >
      +
    </button>
  )
  const plusMenu = plusOpen && (
    <PlusMenu
      t={t}
      className={start ? 'wl-plus' : ''}
      skills={skills}
      onFiles={() => {
        setPlusOpen(false)
        picker.current?.click()
      }}
      onImages={() => {
        setPlusOpen(false)
        imagePicker.current?.click()
      }}
      onSkill={() => {
        setPlusOpen(false)
        setDraft('/')
        box.current?.focus()
      }}
    />
  )
  const textarea = (
    <textarea
      ref={box}
      value={draft}
      placeholder={start ? t('startPlaceholder') : chatPlaceholder}
      aria-label={t('message')}
      disabled={disabled}
      role="combobox"
      aria-expanded={matches.length > 0}
      aria-controls={paletteId}
      aria-autocomplete="list"
      aria-activedescendant={matches.length ? `${paletteId}-${active}` : undefined}
      onChange={e => {
        setDraft(e.target.value)
        setSelected(0)
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      autoFocus={start}
    />
  )
  const inputs = (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label={t('uploadFile')}
        onChange={e => {
          setFiles([...files, ...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <input
        ref={imagePicker}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label={t('addImage')}
        onChange={e => {
          setFiles([...files, ...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
    </>
  )
  const send = busy ? (
    <button type="button" className="send" aria-label={t('stop')} onClick={onStop}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    </button>
  ) : (
    <button
      type="submit"
      className="send"
      aria-label={start ? t('start') : t('send')}
      disabled={disabled || (!draft.trim() && !files.length)}
    >
      <SendIcon />
    </button>
  )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSend()
  }
  if (start) {
    return (
      <form className="wl-box" onSubmit={submit}>
        <Attachments t={t} files={files} setFiles={setFiles} />
        {palette}
        {textarea}
        {inputs}
        <div className="row" style={{ position: 'relative' }}>
          {plus}
          {plusMenu}
          {send}
        </div>
      </form>
    )
  }
  return (
    <form onSubmit={submit}>
      {palette}
      {plusMenu}
      <Attachments t={t} files={files} setFiles={setFiles} />
      <div className="cbox">
        {inputs}
        {textarea}
        {send}
      </div>
      <div className="crow">
        {plus}
        {crow}
      </div>
    </form>
  )
}

/** Permission mode on the left of the composer row. */
export function ModeButton({
  t,
  mode,
  onMode,
}: {
  t: T
  mode: string
  onMode: (mode: string) => void
}) {
  const current = modeOf(mode)
  return (
    <FootMenu
      buttonClass="perm"
      buttonProps={{ 'data-mode': current.key }}
      button={
        <>
          <span className="pmark" aria-hidden="true">
            {current.mark}
          </span>
          <span>{current.label}</span>
        </>
      }
    >
      {close => <ModeItems t={t} mode={current.key} onMode={onMode} close={close} />}
    </FootMenu>
  )
}

/** Labels of the approval options, numbered like the prototype's dock. */
function approvalOptions(approval: Approval, t: T): { key: ApprovalChoice; label: string; hint?: string }[] {
  const rules = approval.suggestions
    .flatMap(s => {
      const rule = s as { rules?: { toolName?: string; ruleContent?: string }[] }
      return (rule.rules ?? []).map(r => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : (r.toolName ?? '')))
    })
    .filter(Boolean)
  return [
    { key: 'allow', label: t('allowOnce') },
    ...(approval.suggestions.length
      ? [{ key: 'always' as const, label: t('allowSession'), hint: rules.join(', ') || undefined }]
      : []),
    { key: 'deny', label: t('denyTell') },
  ]
}

/**
 * The pending approval, docked above the input box: one at a time, the rest
 * counted. Number keys, ↑↓ and Enter answer it, Esc denies, unless focus is in
 * an input or a side panel.
 */
export function AskDock({
  approval,
  more,
  cwd,
  t,
  onAnswer,
}: {
  approval: Approval
  more: number
  cwd?: string
  t: T
  onAnswer: (choice: ApprovalChoice) => void
}) {
  const options = approvalOptions(approval, t)
  const [sel, setSel] = useState(0)
  const titleId = useId()
  useEffect(() => setSel(0), [approval.requestId])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('textarea, input, select, .sessions, .side, .artview, .dialog')) return
      const n = Number(e.key)
      if (n >= 1 && n <= options.length) {
        e.preventDefault()
        onAnswer(options[n - 1]!.key)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel(s => moveSelection(s, e.key === 'ArrowDown' ? 1 : -1, options.length))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onAnswer(options[sel]!.key)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onAnswer('deny')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, sel, onAnswer])
  const summary = toolSummary(approval.toolName, JSON.stringify(approval.input))
  return (
    <div className="askdock" role="dialog" aria-labelledby={titleId}>
      <div className="ahead">
        <b id={titleId}>
          {approval.toolName === 'Bash'
            ? t('wantsToRunCommand')
            : t('wantsToUse', { tool: approval.toolName })}
        </b>
        <small>
          {[approval.toolName, cwd].filter(Boolean).join(' · ')}
          {more > 0 && ` · ${t('moreWaiting', { n: String(more) })}`}
        </small>
      </div>
      {summary && <code>{summary}</code>}
      <div className="opts2" role="listbox" aria-label={approval.toolName}>
        {options.map((o, i) => (
          <button
            type="button"
            key={o.key}
            className="opt2"
            role="option"
            aria-selected={i === sel}
            onClick={() => onAnswer(o.key)}
          >
            <span className="k">{i + 1}</span>
            {o.label}
            {o.hint && <small className="mono">{o.hint}</small>}
          </button>
        ))}
      </div>
      <div className="afoot">
        <span>{t('askKeys', { n: String(options.length) })}</span>
      </div>
    </div>
  )
}
