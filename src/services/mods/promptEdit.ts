import { isDeepStrictEqual } from 'node:util'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import type { TextInputEdit } from '../../types/textInputTypes.js'
import type { PromptBox } from './promptAdapter.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

export type PromptDecoration = {
  start: number
  end: number
  color?: string
  backgroundColor?: string
  dimColor?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}
export type PromptEditInput = PromptBox & {
  origin: {kind: 'composer'}
  key?: TextInputEdit['key']
  start: number
  end: number
  inputText: string
}
export type PromptEditResult = PromptBox & {decorations?: PromptDecoration[]}
type Splice = Pick<PromptEditInput, 'start' | 'end' | 'inputText'>
const decorationStyles = ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough'] as const
const namedColors: Readonly<Record<string, string>> = {
  black: '#000000', red: '#e5484d', green: '#46a758', yellow: '#f5d90a', blue: '#3e63dd', magenta: '#d6409f', cyan: '#05a2c2', white: '#ffffff',
  gray: '#8b8d98', grey: '#8b8d98', blackBright: '#6e6e6e', redBright: '#ff6369', greenBright: '#5bd07f', yellowBright: '#ffe629',
  blueBright: '#5b8def', magentaBright: '#ee6ac2', cyanBright: '#3ec2e0', whiteBright: '#ffffff',
}

export function normalizePromptDecorations(decorations: readonly PromptDecoration[] | undefined, text: string): PromptDecoration[] {
  if (!decorations?.length) return []
  const boundaries = /[^\t\n\x20-\x7e]/.test(text)
    ? [...Array.from(getGraphemeSegmenter().segment(text), part => part.index), text.length] : undefined
  const snap = (offset: number) => {
    const clamped = Math.max(0, Math.min(offset, text.length))
    if (!boundaries) return clamped
    let low = 0, high = boundaries.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (boundaries[mid]! <= clamped) low = mid + 1
      else high = mid
    }
    return boundaries[low - 1] ?? 0
  }
  const spans = decorations.flatMap(run => {
    const start = snap(run.start), end = snap(run.end)
    return end > start ? [{...run, start, end}] : []
  })
  const edges = [...new Set(spans.flatMap(run => [run.start, run.end]))].sort((a, b) => a - b)
  const result: PromptDecoration[] = []
  for (let i = 1; i < edges.length; i++) {
    const start = edges[i - 1]!, end = edges[i]!
    const active = spans.filter(run => run.start <= start && run.end > start)
    if (!active.length) continue
    const combined: PromptDecoration = {start, end}
    for (const run of active) {
      for (const key of decorationStyles) {
        if (run[key] === undefined) continue
        if (key === 'color' || key === 'backgroundColor') {
          const value = run[key]!
          combined[key] = Object.hasOwn(namedColors, value) ? namedColors[value] : value
        } else combined[key] = run[key]
      }
    }
    const previous = result.at(-1)
    if (previous?.end === start && decorationStyles.every(key => previous[key] === combined[key])) previous.end = end
    else result.push(combined)
  }
  return result
}

export function carryPromptDecorations(decorations: readonly PromptDecoration[], before: PromptBox, after: PromptBox): PromptDecoration[] {
  const edit = promptEditSplice(before, after)
  const shift = (offset: number, start: boolean) =>
    (start ? offset >= edit.end : offset > edit.end) ? offset + edit.inputText.length - (edit.end - edit.start)
      : (start ? offset < edit.start : offset <= edit.start) ? offset : edit.start + (start ? edit.inputText.length : 0)
  return normalizePromptDecorations(decorations.flatMap(run => {
    const start = shift(run.start, true), end = shift(run.end, false)
    return end > start ? [{...run, start, end}] : []
  }), after.text)
}

export function promptEditSplice(before: PromptBox, after: PromptBox): Splice {
  if (before.text === after.text) return {start: after.cursor, end: after.cursor, inputText: ''}
  let prefix = 0, suffix = 0
  const common = Math.min(before.cursor, after.cursor, before.text.length, after.text.length)
  while (prefix < common && before.text.charCodeAt(prefix) === after.text.charCodeAt(prefix)) prefix++
  const remaining = Math.min(before.text.length, after.text.length) - prefix
  while (suffix < remaining && before.text.charCodeAt(before.text.length - 1 - suffix) === after.text.charCodeAt(after.text.length - 1 - suffix)) suffix++
  return {start: prefix, end: before.text.length - suffix, inputText: after.text.slice(prefix, after.text.length - suffix)}
}

function spliceBox(box: PromptBox, edit: Splice): PromptBox {
  const start = Math.max(0, Math.min(edit.start, box.text.length))
  const end = Math.max(start, Math.min(edit.end, box.text.length))
  return {text: box.text.slice(0, start) + edit.inputText + box.text.slice(end), cursor: start + edit.inputText.length}
}

export function validatePromptDecorations(value: unknown): asserts value is PromptDecoration[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new TypeError('decorations must be an array of { start, end } runs')
  const styles = ['dimColor', 'bold', 'italic', 'underline', 'strikethrough']
  const keys = ['start', 'end', 'color', 'backgroundColor', ...styles]
  for (const decoration of value) {
    if (decoration && typeof decoration === 'object' && 'virtualText' in decoration)
      throw new TypeError('Prompt decoration virtualText is not available in this build')
    if (!decoration || typeof decoration !== 'object' || Array.isArray(decoration) ||
        Object.keys(decoration).some(key => !keys.includes(key)) ||
        !Number.isInteger(decoration.start) || !Number.isInteger(decoration.end))
      throw new TypeError('Invalid prompt decoration keys or UTF-16 offsets')
    for (const key of styles) if (decoration[key] !== undefined && typeof decoration[key] !== 'boolean')
      throw new TypeError(`Prompt decoration ${key} must be a boolean`)
    for (const key of ['color', 'backgroundColor']) if (decoration[key] !== undefined &&
        (typeof decoration[key] !== 'string' || !/^[#a-zA-Z0-9_().,% -]{1,40}$/.test(decoration[key])))
      throw new TypeError(`Prompt decoration ${key} must be a color`)
  }
}

export function validatePromptEditInput(value: ModInput, received: ModInput): void {
  if (!isDeepStrictEqual(value.origin, received.origin)) throw new TypeError('prompt.edit cannot rewrite origin')
  if (!isDeepStrictEqual(value.key, received.key)) throw new TypeError('prompt.edit cannot rewrite key')
  if (typeof value.text !== 'string' || typeof value.inputText !== 'string')
    throw new TypeError('prompt.edit requires text and inputText strings')
  if (!['cursor', 'start', 'end'].every(key => typeof value[key] === 'number' && Number.isInteger(value[key]) && (value[key] as number) >= 0) ||
      (value.cursor as number) > value.text.length || (value.start as number) > (value.end as number) || (value.end as number) > value.text.length)
    throw new TypeError('prompt.edit cursor, start and end must be ordered UTF-16 offsets inside text')
}

export function validatePromptEditResult(value: unknown): asserts value is PromptEditResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('prompt.edit must return a prompt box')
  const result = value as Partial<PromptEditResult>
  if (typeof result.text !== 'string' || typeof result.cursor !== 'number' || !Number.isInteger(result.cursor) || result.cursor < 0)
    throw new TypeError('prompt.edit must return text and a nonnegative whole cursor')
  validatePromptDecorations(result.decorations)
}

export async function runModPromptEdit(snapshot: ModSnapshot | undefined, edit: TextInputEdit, signal?: AbortSignal): Promise<PromptEditResult> {
  if (!snapshot) return edit.after
  const initial: PromptEditInput = {origin: {kind: 'composer'}, ...edit.before, ...promptEditSplice(edit.before, edit.after),
    ...(edit.key === undefined ? {} : {key: edit.key})}
  const result = await snapshot.dispatch('prompt.edit', initial, async received =>
    ['text', 'cursor', 'start', 'end', 'inputText'].every(key => received[key] === initial[key as keyof PromptEditInput])
      ? edit.after : spliceBox(received as PromptEditInput, received as PromptEditInput), {signal})
  validatePromptEditResult(result)
  return result
}

function clampBox(box: PromptBox): PromptBox {
  return {text: box.text, cursor: Math.max(0, Math.min(box.cursor, box.text.length))}
}

function rebasePromptEdit(before: PromptBox, answer: PromptBox, current: PromptBox): {box?: PromptBox; reason?: string} {
  if (answer.text === before.text && answer.cursor === before.cursor) return {}
  if (current.text === before.text && current.cursor === before.cursor) return {box: clampBox(answer)}
  const interim = promptEditSplice(before, current)
  const rewrite = promptEditSplice(before, answer)
  let moved: Splice | undefined
  if (interim.end - interim.start === before.text.length) moved = undefined
  else if (interim.start === interim.end && interim.inputText === '' || rewrite.end <= interim.start) moved = rewrite
  else if (interim.end <= rewrite.start) {
    const delta = interim.inputText.length - (interim.end - interim.start)
    moved = {start: rewrite.start + delta, end: rewrite.end + delta, inputText: rewrite.inputText}
  }
  if (!moved) return {reason: 'a rewrite no longer fits the draft (it moved meanwhile)'}
  const box = spliceBox(current, moved)
  const delta = moved.inputText.length - (moved.end - moved.start)
  const cursor = current.cursor >= moved.end ? current.cursor + delta
    : current.cursor > moved.start ? moved.start + moved.inputText.length : current.cursor
  return {box: clampBox({...box, cursor})}
}

export function createModPromptEditQueue(host: {
  read(): PromptBox
  commit(box: PromptBox): void
  raise(edit: TextInputEdit, signal: AbortSignal): Promise<PromptEditResult>
  paint?(decorations: PromptDecoration[] | undefined, text: string): void
  carry?(edit: TextInputEdit): void
  report(reason: string): void
  later?(job: () => void): void
}) {
  const controller = new AbortController()
  let pending: TextInputEdit[] = [], inFlight: TextInputEdit | undefined, scheduled = false
  function flush() {
    scheduled = false
    if (!pending.length || inFlight || controller.signal.aborted) return
    const edits = pending
    pending = []
    const edit: TextInputEdit = {before: edits[0]!.before, after: edits.at(-1)!.after,
      ...(edits.length === 1 && edits[0]!.key !== undefined ? {key: edits[0]!.key} : {})}
    inFlight = edit
    void host.raise(edit, controller.signal).then(answer => settle(edit, answer), error => {
      host.report(`prompt.edit: ${error instanceof Error ? error.message : String(error)}; the editor's edit stands`)
      settle(edit, edit.after)
    })
  }
  function settle(edit: TextInputEdit, answer: PromptEditResult) {
    inFlight = undefined
    if (controller.signal.aborted) return
    const result = rebasePromptEdit(edit.after, answer, host.read())
    if (result.box) host.commit(result.box)
    else if (result.reason) host.report(`prompt.edit: ${result.reason}; the person's typing stands`)
    if (host.read().text === answer.text) host.paint?.(answer.decorations, answer.text)
    flush()
  }
  return {
    record(edit: TextInputEdit) {
      if (controller.signal.aborted) return
      host.carry?.(edit)
      pending.push(edit)
      if (!scheduled && !inFlight) {scheduled = true; (host.later ?? queueMicrotask)(flush)}
    },
    dispose() {pending = []; controller.abort()},
  }
}
