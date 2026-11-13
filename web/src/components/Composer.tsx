import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { agentCommands, filterCommands, moveSelection, paletteQuery, recallList, recallPrompt, type SlashCommand, typedInFull } from '../commands'
import { type Daybreak, type HistoryScope, loadPromptHistory, recordPrompt } from '../api'
import { formatBytes, mentionPath } from '../files'
import { type Approval, type ApprovalChoice, approvalRules, approvalScope, approvalUpdates, type CodexAppMention, type ContextUsage, type Goal, type ModelOption, type PromptDecoration, type Todo } from '../protocol'
import { modColor } from './Mods'
import { approvalText } from '../tools'
import { modelName, modelOption } from './Message'
import { FootMenu, modeOf, nextMode, offeredModes, SendIcon, type T } from './ui'

const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const DAYBREAK: Daybreak[] = ['off', 'blue', 'red']

/** `Opus 5.5 · high`: the model button's label. */
export function modelButtonLabel(
  model: string | undefined,
  effort: string | undefined,
  models: ModelOption[],
  t: T,
  runs?: string,
): string {
  // `default` is named by the model it resolves to, like the prototype's `Opus 5.5 · high`:
  // `runs` when the server said (a saved model), else the default row's, else a list without a
  // default row (a ChatGPT sign-in) runs its first model.
  const resolved =
    !model || model === 'default'
      ? (runs ?? models.find(m => m.value === 'default')?.resolvedModel ?? (models.some(m => m.value === 'default') ? model : models[0]?.value) ?? model)
      : model
  const name = modelName(resolved, models) ?? t('model')
  return effort ? `${name} · ${effort}` : name
}

/** The description without the leading model name and the prices: `Best for everyday, complex tasks`. */
function modelHint(m: ModelOption): string | undefined {
  const parts = (m.description ?? '').split(' · ')
  if (parts[0]?.startsWith(`${m.displayName} `)) {
    // `Opus 5.5 · …` leads with the full name; a sentence `GPT-6.1 Terra Codex model.` keeps its rest.
    if (parts.length > 1) parts.shift()
    else parts[0] = parts[0].slice(m.displayName.length + 1)
  }
  return parts.filter(p => p && !p.startsWith('$')).join(' · ') || undefined
}

/** Model list and effort levels, the prototype's `#model-menu`. */
/**
 * The effort levels the menu offers for `model` (the default model's when unset), plus the current
 * level when the model does not list it (a settings `effortLevel`), so the menu matches the chip.
 */
export function effortChoices(model: string | undefined, models: ModelOption[], effort: string | undefined): string[] {
  const listed = (modelOption(model, models) ?? models.find(m => m.value === 'default'))?.effortLevels
  const levels = listed?.length ? listed : FALLBACK_EFFORTS
  return effort && !levels.includes(effort) ? [...levels, effort] : levels
}

/**
 * The context-window stops for `model`: auto (null), then its tiers, plus a configured window that is
 * not a tier; a window above the model maximum shows as the maximum, which is what it resolves to.
 */
export function contextWindowChoices(
  model: string | undefined,
  models: ModelOption[],
  value: number | null | undefined,
): (number | null)[] {
  const tiers = (modelOption(model, models) ?? models.find(m => m.value === 'default'))?.contextWindowTiers ?? []
  if (tiers.length === 0) return []
  if (typeof value === 'number' && value < tiers.at(-1)! && !tiers.includes(value)) {
    return [null, ...[...tiers, value].sort((a, b) => a - b)]
  }
  return [null, ...tiers]
}

/** 272000 → "272k", 1000000 → "1M". */
export function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`
}

/**
 * The model rows shown before "More models": the first four plus the current one. A list with
 * only one more row than that shows it rather than a "More models" row.
 */
export function shownModels(models: ModelOption[], current: string | undefined, expanded: boolean): ModelOption[] {
  if (expanded || models.length <= 5) return models
  return models.filter((m, i) => i < 4 || m.value === current)
}

export function ModelMenu({
  t,
  model,
  effort,
  models,
  onModel,
  onEffort,
  close,
  heading,
  locked = false,
  daybreak,
  contextWindow,
}: {
  t: T
  model: string | undefined
  effort: string | undefined
  models: ModelOption[]
  onModel: (value: string) => void
  onEffort?: (level: string) => void
  close: () => void
  /** In place of "Model" (a project task's menu says when a pick applies). */
  heading?: string
  /** Shown but not changeable (a running task keeps its model). */
  locked?: boolean
  /** The Daybreak access program, offered under a ChatGPT sign-in. */
  daybreak?: { value: string; onChange: (value: Daybreak) => void }
  /** The session's context window (null is auto), from the model's tiers. */
  contextWindow?: { value: number | null | undefined; onChange: (value: number | null) => void }
}) {
  const current = modelOption(model, models)
  const tiers = contextWindowChoices(model, models, contextWindow?.value)
  const maxWindow = tiers.at(-1)
  const selectedWindow =
    typeof contextWindow?.value === 'number' && typeof maxWindow === 'number'
      ? Math.min(contextWindow.value, maxWindow)
      : null
  const levels = effortChoices(model, models, effort)
  const [expanded, setExpanded] = useState(false)
  const shown = shownModels(models, current?.value, expanded)
  return (
    <>
      <div className="mh">{heading ?? t('modelGroup')}</div>
      {shown.map(m => (
        <button
          type="button"
          role="menuitemradio"
          key={m.value}
          disabled={locked}
          aria-checked={current?.value === m.value}
          onClick={() => {
            onModel(m.value)
            close()
          }}
        >
          {modelName(m.value, models) ?? m.displayName}
          {modelHint(m) && <small title={modelHint(m)}>{modelHint(m)}</small>}
        </button>
      ))}
      {shown.length < models.length && (
        <button type="button" className="mm-more" aria-expanded={false} onClick={() => setExpanded(true)}>
          {t('moreModels', { n: String(models.length - shown.length) })} <span aria-hidden="true">›</span>
        </button>
      )}
      {onEffort && (
        <div className="mm-effort">
          <div className="mh">{t('effort')}</div>
          <div className="seg" role="radiogroup" aria-label={t('effort')}>
            {levels.map(level => (
              <button
                type="button"
                role="radio"
                key={level}
                disabled={locked}
                aria-checked={effort === level}
                onClick={() => onEffort(level)}
              >
                {level}
              </button>
            ))}
          </div>
          {contextWindow && tiers.length > 1 && (
            <>
              <div className="mh">{t('contextWindow')}</div>
              <div className="seg" role="radiogroup" aria-label={t('contextWindow')}>
                {tiers.map(tier => (
                  <button
                    type="button"
                    role="radio"
                    key={tier ?? 'auto'}
                    disabled={locked}
                    aria-checked={selectedWindow === tier}
                    onClick={() => contextWindow.onChange(tier)}
                  >
                    {tier === null ? 'auto' : formatWindow(tier)}
                  </button>
                ))}
              </div>
            </>
          )}
          {daybreak && (
            <>
              <div className="mh">Daybreak</div>
              <div className="seg" role="radiogroup" aria-label="Daybreak">
                {DAYBREAK.map(value => (
                  <button
                    type="button"
                    role="radio"
                    key={value}
                    aria-checked={daybreak.value === value}
                    onClick={() => daybreak.onChange(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

/** The five permission modes with their marks and one-line descriptions. */
export function ModeItems({
  t,
  mode,
  plan,
  onMode,
  close,
}: {
  t: T
  mode: string
  /** Settings allow plan mode. */
  plan?: boolean
  onMode: (mode: string) => void
  close: () => void
}) {
  return (
    <>
      {offeredModes(plan, mode).map(m => (
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
  onMention,
  skills,
}: {
  t: T
  className: string
  onFiles: () => void
  onImages: () => void
  onSkill: () => void
  onMention?: () => void
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
      {onMention && (
        <button type="button" onClick={onMention}>
          <span className="mono">@</span>
          <span>
            {t('mentionFile')}
            <small>{t('mentionFileHint')}</small>
          </span>
        </button>
      )}
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
 * prototype's `.wl-box`, otherwise `.cbox`: the text, then its `.crow` of controls and send.
 */
export function InputBox({
  t,
  start,
  busy,
  disabled: disabledProp,
  signedOut,
  draft,
  setDraft,
  onSend,
  onSendNow,
  onStop,
  onFocus,
  files,
  setFiles,
  commands = [],
  hiddenCommands,
  skills = [],
  onShiftTab,
  crow,
  listFiles,
  apps = [],
  prompts = [],
  history,
  placeholder,
  targets,
  picked = [],
  onTarget,
  quote,
  onQuote,
  decorations,
  modRows = [],
  onModRow,
}: {
  t: T
  start?: boolean
  busy: boolean
  disabled?: boolean
  /** Signed out: the box is disabled and says why (prototype `setPlaceholder`). */
  signedOut?: boolean
  draft: string
  setDraft: (v: string) => void
  onSend: () => void
  /** ctrl+enter, like the TUI's chat:sendNow: run without waiting behind the turn. */
  onSendNow?: () => void
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
  /** Workspace files matching an `@` query, relative to the working directory. */
  listFiles?: (query: string) => Promise<string[]>
  /** ChatGPT apps an `@codex-app:<mention>` can call on. */
  apps?: CodexAppMention[]
  /** Prompts sent in this chat, oldest first, for ↑ / ↓. */
  prompts?: string[]
  /** The folder's ↑ history (shared with the CLI): ↑ goes on into it, and what is sent here is added. */
  history?: HistoryScope
  /** Replaces the chat placeholder (a project's coordinator and task boxes). */
  placeholder?: string
  /** Tasks or agents an `@` can address; the picked ones get the message instead of this chat. */
  targets?: MentionTarget[]
  /** The picked recipients, in the order they were picked. */
  picked?: MentionTarget[]
  onTarget?: (picked: MentionTarget[]) => void
  /** Text from the conversation this message replies to; sent ahead of the draft as a blockquote. */
  quote?: string
  onQuote?: (quote: string | undefined) => void
  /** How Mods mark the draft (`prompt.edit` decorations), drawn under the text. */
  decorations?: PromptDecoration[]
  /** Completions a Mod offers for the token being typed (`prompt.complete`). */
  modRows?: { text: string; label?: string; description?: string }[]
  onModRow?: (row: { text: string }) => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const paletteId = useId()
  const disabled = disabledProp || signedOut
  const chatPlaceholder = usePlaceholder(t)
  const [plusOpen, setPlusOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState(0)
  // Esc closes the palette for this exact draft; typing reopens it.
  const [dismissed, setDismissed] = useState<string>()
  // Once the draft moves on, the same text typed again later opens the palette again.
  useEffect(() => {
    if (dismissed !== undefined && draft !== dismissed) setDismissed(undefined)
  }, [draft, dismissed])
  // The `@query` before the caret, and the files it matches.
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>()
  const [fileHits, setFileHits] = useState<{ query: string; files: string[] }>()
  const [recall, setRecall] = useState<{ index: number; text: string }>()
  const [shared, setShared] = useState<string[]>([])
  const recallable = useMemo(() => recallList(prompts, shared), [prompts, shared])
  const historyCwd = history?.cwd
  const loadShared = useCallback(() => {
    if (historyCwd) loadPromptHistory(historyCwd).then(setShared, () => {})
  }, [historyCwd])
  useEffect(() => {
    setShared([])
    loadShared()
  }, [loadShared])
  const query = dismissed === draft ? undefined : paletteQuery(draft)
  const fileMatches =
    mention && dismissed !== draft && fileHits?.query === mention.query ? fileHits.files : []
  const targetMatches =
    mention && dismissed !== draft && targets && onTarget
      ? matchTargets(targets, mention.query).filter(x => !picked.some(p => p.id === x.id))
      : []
  const appMatches = mention && dismissed !== draft ? matchApps(apps, mention.query) : []
  const mentionCount = targetMatches.length + appMatches.length + fileMatches.length
  const matches = query === undefined ? [] : filterCommands(commands, query, hiddenCommands)
  const modMatches = mentionCount || matches.length || dismissed === draft || !onModRow ? [] : modRows
  const listLength = mentionCount || matches.length || modMatches.length
  const mentions = Boolean(listFiles || targets?.length || apps.length)
  const active = Math.min(selected, listLength - 1)
  useEffect(() => {
    if (!mention || !listFiles) return
    let stale = false
    const timer = setTimeout(() => {
      listFiles(mention.query).then(
        files => !stale && setFileHits({ query: mention.query, files }),
        () => !stale && setFileHits({ query: mention.query, files: [] }),
      )
    }, 120)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [mention, listFiles])
  const findMention = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart)
    const m = /(^|\s)@([^\s"]*)$/.exec(before)
    setMention(m ? { start: before.length - m[2]!.length - 1, end: before.length, query: m[2]! } : undefined)
  }
  // Where a pick puts the caret, set as soon as the new draft is in the box: a frame later could
  // land after the person's next edit and undo its selection.
  const caretAfterPick = useRef<number>(undefined)
  useLayoutEffect(() => {
    if (caretAfterPick.current === undefined) return
    box.current?.setSelectionRange(caretAfterPick.current, caretAfterPick.current)
    caretAfterPick.current = undefined
  })
  const pickFile = (path: string) => {
    if (!mention) return
    const token = /\s/.test(path) ? mentionPath(path) : `@${path}`
    const next = `${draft.slice(0, mention.start)}${token} ${draft.slice(mention.end)}`
    const caret = mention.start + token.length + 1
    setDraft(next)
    setMention(undefined)
    setSelected(0)
    caretAfterPick.current = caret
  }
  const pickTarget = (x: MentionTarget) => {
    if (!mention) return
    setDraft(`${draft.slice(0, mention.start)}${draft.slice(mention.end).replace(/^ /, '')}`)
    setMention(undefined)
    setSelected(0)
    if (!picked.some(p => p.id === x.id)) onTarget?.([...picked, x])
    caretAfterPick.current = mention.start
  }
  const pickApp = (app: CodexAppMention) => {
    if (!mention) return
    const token = `@codex-app:${app.mention} `
    const caret = mention.start + token.length
    setDraft(`${draft.slice(0, mention.start)}${token}${draft.slice(mention.end).replace(/^ /, '')}`)
    setMention(undefined)
    setSelected(0)
    caretAfterPick.current = caret
  }
  const pickMention = (i: number) => {
    if (i < targetMatches.length) return pickTarget(targetMatches[i]!)
    const a = i - targetMatches.length
    if (a < appMatches.length) return pickApp(appMatches[a]!)
    pickFile(fileMatches[a - appMatches.length]!)
  }
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
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      plusRef.current?.focus()
      setPlusOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [plusOpen])
  // Grow with the text up to the CSS max-height. A hidden box (a project page is
  // showing) measures 0: keep the CSS height and measure again once it is shown.
  useEffect(() => {
    const el = box.current
    if (!el || start) return
    const grow = () => {
      el.style.height = ''
      if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    }
    grow()
    const seen = new ResizeObserver(() => {
      if (!el.style.height) grow()
    })
    seen.observe(el)
    return () => seen.disconnect()
  }, [draft, start])
  useEffect(() => {
    if (quote) box.current?.focus()
  }, [quote])
  // Typed prompts join the folder's history, as the CLI adds each prompt it submits.
  const sendNow = (now = false) => {
    const text = draft.trim()
    if (history && text && !disabled) {
      recordPrompt(history, text).then(loadShared, () => {})
      setShared(s => [text, ...s.filter(p => p !== text)])
    }
    if (now && onSendNow) onSendNow()
    else onSend()
  }
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
    if (mentionCount && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(moveSelection(active, e.key === 'ArrowDown' ? 1 : -1, mentionCount))
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        pickMention(active)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(draft)
        return
      }
    }
    // ↑ on an empty input (or on a recalled prompt left as it was) walks back through the sent prompts.
    const recalling = recall !== undefined && recall.index >= 0 && draft === recall.text
    if ((e.key === 'ArrowUp' || (e.key === 'ArrowDown' && recalling)) && (draft === '' || recalling) && !matches.length) {
      const next = recallPrompt(recallable, recalling ? recall.index : -1, e.key === 'ArrowUp' ? 1 : -1)
      if (next) {
        e.preventDefault()
        setRecall(next)
        setDraft(next.text)
        return
      }
    }
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
      if (e.key === 'Enter' && !e.shiftKey && !typedInFull(draft, command)) {
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
    if (modMatches.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(moveSelection(active, e.key === 'ArrowDown' ? 1 : -1, modMatches.length))
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        onModRow?.(modMatches[active]!)
        setSelected(0)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(draft)
        return
      }
    }
    if (e.key === 'Backspace' && picked.length && box.current?.selectionEnd === 0) {
      e.preventDefault()
      onTarget?.(picked.slice(0, -1))
      return
    }
    if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
      e.preventDefault()
      onShiftTab()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      sendNow(e.ctrlKey || e.metaKey)
    }
    if (e.key === 'Escape' && busy) onStop()
  }
  const skillSet = new Set(skills)
  const palette = mentionCount > 0 ? (
    <div className="pop" id={paletteId} role="listbox" aria-label={t('completions')}>
      {targetMatches.length > 0 && <div className="sec">{t('mentionTargets')}</div>}
      {targetMatches.map((x, i) => (
        <button
          type="button"
          key={x.id}
          id={`${paletteId}-${i}`}
          className="opt"
          role="option"
          aria-selected={i === active}
          onMouseDown={e => e.preventDefault()}
          onMouseEnter={() => setSelected(i)}
          onClick={() => pickTarget(x)}
        >
          <b title={x.name}>@{x.name}</b>
          <span>{x.detail}</span>
          <em>{x.tag}</em>
        </button>
      ))}
      {appMatches.length > 0 && <div className="sec">{t('chatgptApps')}</div>}
      {appMatches.map((app, a) => {
        const i = a + targetMatches.length
        return (
          <button
            type="button"
            key={app.mention}
            id={`${paletteId}-${i}`}
            className="opt"
            role="option"
            aria-selected={i === active}
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => setSelected(i)}
            onClick={() => pickApp(app)}
          >
            <b title={`@codex-app:${app.mention}`}>@{app.name}</b>
            <span>{app.description ?? `codex-app:${app.mention}`}</span>
            <em>{t('appTag')}</em>
          </button>
        )
      })}
      {fileMatches.length > 0 && (targetMatches.length + appMatches.length > 0 || !mention?.query) && (
        <div className="sec">{t('workspaceFiles')}</div>
      )}
      {fileMatches.map((path, f) => {
        const i = f + targetMatches.length + appMatches.length
        return (
          <button
            type="button"
            key={path}
            id={`${paletteId}-${i}`}
            className="opt"
            role="option"
            aria-selected={i === active}
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => setSelected(i)}
            onClick={() => pickFile(path)}
          >
            <b title={`@${path}`}>@{path}</b>
            <span>{path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : './'}</span>
            <em>{t('fileTag')}</em>
          </button>
        )
      })}
    </div>
  ) : matches.length > 0 ? (
    <div className="pop" id={paletteId} role="listbox" aria-label={t('completions')}>
      {matches.map((command, i) => {
        const isSkill = skillSet.has(command.name)
        const section = isSkill ? 'Skills' : t('commandsSection')
        const prev = matches[i - 1]
        const description = `${command.description}${command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''}`
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
            <b title={`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`}>
              /{command.name}
              {command.argumentHint && <small> {command.argumentHint}</small>}
            </b>
            <span title={description}>{description}</span>
            <em>{isSkill ? t('skillTag') : t('commandTag')}</em>
          </button>,
        ]
      })}
    </div>
  ) : modMatches.length > 0 && (
    <div className="pop" id={paletteId} role="listbox" aria-label={t('modSuggestions')}>
      {modMatches.map((row, i) => (
        <button
          type="button"
          key={row.text}
          id={`${paletteId}-${i}`}
          className="opt"
          role="option"
          aria-selected={i === active}
          onMouseDown={e => e.preventDefault()}
          onMouseEnter={() => setSelected(i)}
          onClick={() => onModRow?.(row)}
        >
          <b title={row.text}>{row.label ?? row.text}</b>
          <span title={row.description}>{row.description}</span>
        </button>
      ))}
    </div>
  )
  const plus = (
    <button
      type="button"
      className="plus"
      ref={plusRef}
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
      onMention={
        listFiles &&
        (() => {
          setPlusOpen(false)
          const next = `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}@`
          setDraft(next)
          setMention({ start: next.length - 1, end: next.length, query: '' })
          box.current?.focus()
        })
      }
    />
  )
  const textarea = (
    <textarea
      ref={box}
      value={draft}
      placeholder={
        signedOut
          ? t('signInToSend')
          : start
            ? t('startPlaceholder')
            : picked.length === 1
              ? t('messageTarget', { name: picked[0]!.name })
              : picked.length > 1
                ? t('messageTargets', { count: String(picked.length) })
                : (placeholder ?? chatPlaceholder)
      }
      aria-label={t('message')}
      disabled={disabled}
      role="combobox"
      aria-expanded={listLength > 0}
      aria-controls={paletteId}
      aria-autocomplete="list"
      aria-activedescendant={listLength ? `${paletteId}-${active}` : undefined}
      onChange={e => {
        setDraft(e.target.value)
        setSelected(0)
        if (mentions) findMention(e.target)
      }}
      onClick={e => mentions && findMention(e.currentTarget)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      onScroll={e => {
        if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop
      }}
      autoFocus={start}
    />
  )
  const mirror = useRef<HTMLDivElement>(null)
  const marked = decorations?.length ? (
    <div className="cdeco">
      <div className="cdeco-mirror" ref={mirror} aria-hidden="true">
        {decoratedRuns(draft, decorations).map((run, i) =>
          run.mark ? (
            <span key={i} style={decorationStyle(run.mark)}>
              {run.text}
            </span>
          ) : (
            run.text
          ),
        )}
        {'\n'}
      </div>
      {textarea}
    </div>
  ) : (
    textarea
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
  // With text in the box a running turn still takes it (queued, fed in between tool calls).
  const send = busy && !draft.trim() && !files.length ? (
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
    sendNow()
  }
  // Files dropped on the box attach to it; a page area that also takes drops sees `defaultPrevented`.
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!disabled && e.dataTransfer.types.includes('Files')) e.preventDefault()
    },
    onDrop: (e: DragEvent) => {
      if (disabled || !e.dataTransfer.files.length) return
      e.preventDefault()
      setFiles([...files, ...e.dataTransfer.files])
    },
  }
  if (start) {
    return (
      <form className="wl-box" onSubmit={submit} {...drop}>
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
    <form onSubmit={submit} {...drop}>
      {palette}
      {plusMenu}
      <Attachments t={t} files={files} setFiles={setFiles} />
      <div className="cbox">
        {inputs}
        {quote && (
          <div className="cquote">
            <span className="cquote-text" title={quote}>
              {quote}
            </span>
            <button
              type="button"
              className="x"
              aria-label={t('removeQuote')}
              title={t('removeQuote')}
              onClick={() => {
                onQuote?.(undefined)
                box.current?.focus()
              }}
            >
              ×
            </button>
          </div>
        )}
        <div className="cin">
          {picked.length > 0 && (
            <span className="to-chips">
              {picked.map(x => (
                <span className="to-chip" key={x.id} title={x.name}>
                  <span>@{x.name}</span>
                  <button
                    type="button"
                    aria-label={t('clearTarget')}
                    onClick={() => onTarget?.(picked.filter(p => p.id !== x.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </span>
          )}
          {marked}
        </div>
        <div className="crow">
          {plus}
          {crow}
          {send}
        </div>
      </div>
    </form>
  )
}

/** A task or agent the composer's `@` can address. */
export type MentionTarget = { id: string; name: string; detail: string; tag: string }

/** Targets whose name or detail holds the query, name matches first. */
/** The draft cut where Mods' decorations start and end; overlapping ones: the later wins. */
export function decoratedRuns(text: string, decorations: PromptDecoration[]): { text: string; mark?: PromptDecoration }[] {
  const marks: (PromptDecoration | undefined)[] = Array.from({ length: text.length })
  for (const d of decorations) {
    for (let i = Math.max(0, d.start); i < Math.min(text.length, d.end); i++) marks[i] = d
  }
  const runs: { text: string; mark?: PromptDecoration }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1)
    if (last && last.mark === marks[i]) last.text += text[i]
    else runs.push({ text: text[i]!, ...(marks[i] && { mark: marks[i] }) })
  }
  return runs
}

/** Only what keeps the text where the box draws it: a background and lines, no weight or slant. */
function decorationStyle(d: PromptDecoration): CSSProperties {
  const color = modColor(d.color)
  const lines = [d.underline && 'underline', d.strikethrough && 'line-through'].filter(Boolean).join(' ')
  return {
    background: modColor(d.backgroundColor) ?? (color && !lines ? `color-mix(in srgb, ${color} 22%, transparent)` : undefined),
    textDecorationLine: lines || undefined,
    textDecorationColor: lines ? (color ?? 'currentColor') : undefined,
    opacity: d.dimColor ? 0.5 : undefined,
  }
}

export function matchTargets(targets: MentionTarget[], query: string): MentionTarget[] {
  const q = query.toLowerCase()
  const inName = targets.filter(x => x.name.toLowerCase().includes(q))
  return [...inName, ...targets.filter(x => !inName.includes(x) && x.detail.toLowerCase().includes(q))]
}

/** Apps whose mention or name holds the query; a typed `codex-app:` prefix is ignored. */
export function matchApps(apps: CodexAppMention[], query: string): CodexAppMention[] {
  const q = query.toLowerCase().replace(/^codex-app:/, '')
  return apps.filter(app => app.mention.includes(q) || app.name.toLowerCase().includes(q))
}

/** Permission mode on the left of the composer row. */
/** What a chat box can do; every field is required so no surface goes without one. */
export type ComposerTools = {
  /** The session's slash commands and skills (`initialize` / `system/init`). */
  commands: SlashCommand[]
  hiddenCommands: string[]
  skills: string[]
  listFiles: (query: string) => Promise<string[]>
  /** The session's enabled ChatGPT apps, offered after `@`. */
  apps: CodexAppMention[]
  /** Prompts already sent to this target, oldest first, for ↑ / ↓. */
  prompts: string[]
  /** The folder's ↑ history, shared with the CLI; undefined where there is none (a temporary chat). */
  history: HistoryScope | undefined
  mode: { mode: string; plan?: boolean; onMode: (mode: string) => void }
  model: {
    model: string | undefined
    effort: string | undefined
    models: ModelOption[]
    onModel: (value: string) => void
    onEffort: (level: string) => void
    heading?: string
    locked?: boolean
    daybreak?: { value: string; onChange: (value: Daybreak) => void }
    contextWindow?: { value: number | null | undefined; onChange: (value: number | null) => void }
  }
}

/** A session's palette and permission mode, the part of {@link ComposerTools} every box in it shares. */
export function chatTools(
  chat: { commands: SlashCommand[]; terminalCommands: string[]; permissionMode?: string; env: { skills?: string[]; planMode?: boolean; codexApps?: CodexAppMention[] } },
  listFiles: (query: string) => Promise<string[]>,
  prompts: string[],
  history: HistoryScope | undefined,
  onMode: (mode: string) => void,
): Omit<ComposerTools, 'model'> {
  return {
    commands: chat.commands,
    hiddenCommands: chat.terminalCommands,
    skills: chat.env.skills ?? [],
    listFiles,
    apps: chat.env.codexApps ?? [],
    prompts,
    history,
    mode: { mode: chat.permissionMode ?? 'default', plan: chat.env.planMode, onMode },
  }
}

/**
 * The chat input used by every conversation: a session, a project's
 * coordinator, a task and an agent in the side panel. `agent` boxes message a
 * subagent, which gets the text as typed (the CLI's agent view does the same),
 * so their palette offers only skills.
 */
export function ChatComposer({
  tools,
  agent,
  extra,
  ...box
}: Omit<Parameters<typeof InputBox>[0], 'start' | 'commands' | 'hiddenCommands' | 'skills' | 'listFiles' | 'apps' | 'prompts' | 'history' | 'onShiftTab' | 'crow'> & {
  tools: ComposerTools
  agent?: boolean
  /** More buttons in the row, after the mode button (the chat's goal). */
  extra?: ReactNode
}) {
  const { mode, model } = tools
  return (
    <InputBox
      {...box}
      commands={agent ? agentCommands(tools.commands, tools.skills) : tools.commands}
      hiddenCommands={tools.hiddenCommands}
      skills={tools.skills}
      listFiles={tools.listFiles}
      apps={tools.apps}
      prompts={tools.prompts}
      history={tools.history}
      onShiftTab={() => mode.onMode(nextMode(mode.mode, mode.plan))}
      crow={
        <>
          <ModeButton t={box.t} mode={mode.mode} plan={mode.plan} onMode={mode.onMode} />
          {extra}
          {model.models.length > 0 && (
            <FootMenu right label={box.t('model')} button={<span className="ml">{modelButtonLabel(model.model, model.effort, model.models, box.t)}</span>}>
              {close => <ModelMenu t={box.t} {...model} close={close} />}
            </FootMenu>
          )}
        </>
      }
    />
  )
}

export function ModeButton({
  t,
  mode,
  plan,
  onMode,
}: {
  t: T
  mode: string
  plan?: boolean
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
      {close => <ModeItems t={t} mode={current.key} plan={plan} onMode={onMode} close={close} />}
    </FootMenu>
  )
}

/** Labels of the approval options, numbered like the prototype's dock. */
function approvalOptions(approval: Approval, t: T): { key: ApprovalChoice; label: string; hint?: string }[] {
  // Named for where the answer is kept and what it adds, as the TUI's option says.
  const { rules, directories, mode } = approvalRules(approval)
  const scope = approvalScope(approval)
  const hint = [
    ...rules,
    ...(directories.length ? [t('approvalDirs', { dirs: directories.join(', ') })] : []),
    ...(mode ? [t('approvalMode', { mode: modeOf(mode).label })] : []),
  ].join(', ')
  return [
    { key: 'allow', label: t('allowOnce') },
    ...(approvalUpdates(approval).length
      ? [{ key: 'always' as const, label: t(scope === 'user' ? 'allowUser' : scope === 'project' ? 'allowProject' : 'allowSession'), hint: hint || undefined }]
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
  const dockRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setSel(0)
    // Just after sending, focus is still in the empty input box, where these keys would type or interrupt instead.
    const active = document.activeElement
    if (!(active instanceof HTMLTextAreaElement) || active.value.trim()) return
    dockRef.current?.querySelector<HTMLButtonElement>('.opt2')?.focus()
    // Once answered, typing goes back to the input box.
    return () => {
      if (!document.activeElement || document.activeElement === document.body) active.focus()
    }
  }, [approval.requestId])
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
  const summary = approvalText(approval.toolName, JSON.stringify(approval.input))
  return (
    <div className="askdock" role="dialog" aria-labelledby={titleId} ref={dockRef}>
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

const TODO_MARK: Record<string, string> = { completed: '✓', in_progress: '◼', pending: '☐' }

/** The running todo; between todos the next one, as the CLI's `Next:` line; `All done` only once all are. */
export function pinText(t: T, todos: Todo[]): string {
  const current = todos.find(x => x.status === 'in_progress')
  if (current) return current.activeForm ?? current.content
  const next = todos.find(x => x.status !== 'completed')
  return next ? t('todoNext', { task: next.content }) : t('allDone')
}

/** The todo pin above the input box: `待办 2/5 · 正在…`, unfolding into the list. */
export function Pins({ t, todos }: { t: T; todos: Todo[] }) {
  const [open, setOpen] = useState(false)
  if (!todos.length) return null
  const done = todos.filter(x => x.status === 'completed').length
  return (
    <div className="pins">
      <div className="pin">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="pmark">☰</span>
          <b>{t('todosPin', { done: String(done), total: String(todos.length) })}</b>
          <span className="ptxt">{pinText(t, todos)}</span>
        </button>
        {open && (
          <div className="pbody">
            {todos.map((x, i) => (
              <div className={`todo-i ${x.status}`} key={i}>
                <span>{TODO_MARK[x.status] ?? '☐'}</span>
                <span>{x.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const minutesSince = (at: number | undefined) =>
  `${Math.max(1, Math.round((Date.now() - (at ?? Date.now())) / 60_000))}m`

/** `◎ 目标 · N 次检查` left of the model button, with the goal, its checks and "clear". */
export function GoalMenu({ t, goal, onClear }: { t: T; goal: Goal; onClear: () => void }) {
  return (
    <FootMenu
      right
      wrapId="goal-wrap"
      buttonClass="goal"
      menuClass="pop footmenu goalmenu"
      button={
        <>
          <span className="pmark" aria-hidden="true">
            ◎
          </span>
          <span id="goal-label">
            {t('goalLabel')}
            {goal.iterations > 0 && <span className="gl-n"> · {t('nChecks', { n: String(goal.iterations) })}</span>}
          </span>
        </>
      }
    >
      {close => (
        <>
          <div className="mh">{t('goalLabel')}</div>
          <div className="gp">{goal.condition}</div>
          <div className="gm">{t('goalRan', { time: minutesSince(goal.setAt), n: String(goal.iterations) })}</div>
          {goal.checks.length > 0 && (
            <ol>
              {goal.checks.map((reason, i) => (
                <li key={i}>{t('goalCheckFailed', { reason })}</li>
              ))}
            </ol>
          )}
          <div className="btns">
            <button
              className="btn"
              type="button"
              onClick={() => {
                close()
                onClear()
              }}
            >
              {t('clearGoal')}
            </button>
          </div>
        </>
      )}
    </FootMenu>
  )
}

/** `76k` / `1.2M` */
export function shortTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(n / 1000)}k`
}

const CTX_COLORS = { system: '#8a8a8a', tools: '#3b6fd8', messages: '#d97757' }

/** The meta row's `38% 上下文` chip and its `#ctxpop` breakdown with `/compact`. */
export function ContextChip({
  t,
  percent,
  context,
  onOpen,
  onCompact,
}: {
  t: T
  percent: number
  context?: ContextUsage
  onOpen: () => void
  onCompact?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>()
  const chip = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = pop.current
    const anchor = chip.current
    if (!open || !el || !anchor) return
    const r = anchor.getBoundingClientRect()
    const parent = el.offsetParent as HTMLElement | null
    const host = parent?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const width = parent?.clientWidth ?? window.innerWidth
    setPos({ top: r.bottom - host.top + 6, left: Math.max(16, Math.min(r.left - host.left, width - el.offsetWidth - 16)) })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!pop.current?.contains(target) && !chip.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pct = Math.round(percent)
  const width = (n: number) => `${context ? Math.min(100, (n / context.max) * 100) : 0}%`
  return (
    <>
      <button
        ref={chip}
        className="chip"
        type="button"
        id="ctx-chip"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
      >
        <span id="ctx">{pct}%</span> {t('contextChip')}
      </button>
      {open && (
        <div
          ref={pop}
          className="ctxpop"
          id="ctxpop"
          role="dialog"
          aria-label={t('contextChip')}
          style={pos ?? { visibility: 'hidden' }}
        >
          <b>
            {t('contextChip')} <span>{pct}%</span>
            {context && (
              <>
                {' · '}
                <span className="mono">{shortTokens(context.total)}</span> / {shortTokens(context.max)}
              </>
            )}
          </b>
          {context && (
            <>
              <div className="ctxmeter">
                <i style={{ width: width(context.system), background: CTX_COLORS.system }} />
                <i style={{ width: width(context.tools), background: CTX_COLORS.tools }} />
                <i style={{ width: width(context.messages), background: CTX_COLORS.messages }} />
                {context.autoCompact && context.threshold !== undefined && (
                  <span className="th" style={{ left: width(context.threshold) }} title={t('ctxThreshold')} />
                )}
              </div>
              <div className="ctxlegend">
                {(['system', 'tools', 'messages'] as const).map(k => (
                  <span key={k} style={{ display: 'contents' }}>
                    <span className="sw" style={{ background: CTX_COLORS[k] }} />
                    <span>{t(k === 'system' ? 'ctxSystem' : k === 'tools' ? 'ctxTools' : 'ctxMessages')}</span>
                    <span className="mono">{shortTokens(context[k])}</span>
                  </span>
                ))}
              </div>
              <span className="note">
                {context.autoCompact && context.threshold !== undefined
                  ? t('ctxNote', { n: shortTokens(context.max - context.threshold) })
                  : t('ctxNoAuto')}
              </span>
            </>
          )}
          {onCompact && (
            <span className="cm-row" style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn primary"
                type="button"
                id="do-compact"
                onClick={() => {
                  setOpen(false)
                  onCompact()
                }}
              >
                {t('compactNow')}
              </button>
            </span>
          )}
        </div>
      )}
    </>
  )
}
