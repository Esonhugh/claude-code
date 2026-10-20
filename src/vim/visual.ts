/**
 * Vim Visual Mode
 *
 * Transitions and operators for VISUAL (`v`) and VISUAL LINE (`V`). The
 * selection runs from `anchor` to the cursor, inclusive of the character
 * under the far end; VISUAL LINE widens it to whole logical lines.
 */

import { Cursor } from '../utils/Cursor.js'
import { firstGrapheme, lastGrapheme } from '../utils/intl.js'
import { resolveMotion } from './motions.js'
import { executeIndent, executeJoin } from './operators.js'
import { findTextObject } from './textObjects.js'
import { executeRepeatFind, type TransitionContext } from './transitions.js'
import {
  FIND_KEYS,
  type FindType,
  isOperatorKey,
  isTextObjScopeKey,
  MAX_VIM_COUNT,
  OPERATORS,
  type Operator,
  SIMPLE_MOTIONS,
  TEXT_OBJ_SCOPES,
  TEXT_OBJ_TYPES,
  type VisualCommandState,
} from './types.js'

export type VisualContext = TransitionContext & {
  anchor: number
  linewise: boolean
  /** Leave VISUAL for NORMAL without touching text or cursor. */
  exitVisual: () => void
  /** Stay in VISUAL with a new anchor and/or kind. */
  setVisual: (anchor: number, linewise: boolean) => void
}

export type VisualTransitionResult = {
  next?: VisualCommandState
  execute?: () => void
}

/**
 * The text range [from, to) covered by a selection.
 */
export function getVisualRange(
  text: string,
  anchor: number,
  offset: number,
  linewise: boolean,
): { from: number; to: number } {
  const start = Math.min(anchor, offset)
  const end = Math.max(anchor, offset)
  if (linewise) {
    const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
    const newline = text.indexOf('\n', end)
    return { from, to: newline === -1 ? text.length : newline + 1 }
  }
  const to = end + (firstGrapheme(text.slice(end)).length || 1)
  return { from: start, to: Math.min(to, text.length) }
}

export function transitionVisual(
  state: VisualCommandState,
  input: string,
  ctx: VisualContext,
): VisualTransitionResult {
  switch (state.type) {
    case 'idle':
      if (/[1-9]/.test(input)) {
        return { next: { type: 'count', digits: input } }
      }
      return handleVisualInput(input, 1, ctx)
    case 'count':
      if (/[0-9]/.test(input)) {
        const count = Math.min(parseInt(state.digits + input, 10), MAX_VIM_COUNT)
        return { next: { type: 'count', digits: String(count) } }
      }
      return handleVisualInput(input, parseInt(state.digits, 10), ctx)
    case 'find':
      if (input === '') return { next: { type: 'idle' } }
      return {
        execute: () => {
          const result = ctx.cursor.findCharacter(input, state.find, state.count)
          if (result !== null) {
            ctx.setOffset(result)
            ctx.setLastFind(state.find, input)
          }
        },
      }
    case 'g':
      if (input === 'g') {
        return {
          execute: () => {
            const target =
              state.count > 1
                ? ctx.cursor.goToLine(state.count)
                : ctx.cursor.startOfFirstLine()
            ctx.setOffset(target.offset)
          },
        }
      }
      if (input === 'j' || input === 'k') {
        return {
          execute: () =>
            ctx.setOffset(
              resolveMotion(`g${input}`, ctx.cursor, state.count).offset,
            ),
        }
      }
      return { next: { type: 'idle' } }
    case 'replace':
      if (input === '') return { next: { type: 'idle' } }
      return { execute: () => replaceSelection(input, ctx) }
    case 'textObj':
      if (TEXT_OBJ_TYPES.has(input)) {
        return { execute: () => selectTextObject(input, state.scope, ctx) }
      }
      return { next: { type: 'idle' } }
  }
}

function handleVisualInput(
  input: string,
  count: number,
  ctx: VisualContext,
): VisualTransitionResult {
  if (SIMPLE_MOTIONS.has(input)) {
    return {
      execute: () => ctx.setOffset(resolveMotion(input, ctx.cursor, count).offset),
    }
  }
  if (input === 'G') {
    return {
      execute: () => {
        const target =
          count === 1 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count)
        ctx.setOffset(target.offset)
      },
    }
  }
  if (input === 'g') return { next: { type: 'g', count } }
  if (FIND_KEYS.has(input)) {
    return { next: { type: 'find', find: input as FindType, count } }
  }
  if (input === ';' || input === ',') {
    return { execute: () => executeRepeatFind(input === ',', count, ctx) }
  }
  if (isTextObjScopeKey(input)) {
    return { next: { type: 'textObj', scope: TEXT_OBJ_SCOPES[input] } }
  }
  if (isOperatorKey(input)) {
    return { execute: () => applyVisualOperator(OPERATORS[input], false, ctx) }
  }

  switch (input) {
    case 'x':
      return { execute: () => applyVisualOperator('delete', false, ctx) }
    case 'X':
    case 'D':
      return { execute: () => applyVisualOperator('delete', true, ctx) }
    case 's':
      return { execute: () => applyVisualOperator('change', false, ctx) }
    case 'C':
    case 'S':
    case 'R':
      return { execute: () => applyVisualOperator('change', true, ctx) }
    case 'Y':
      return { execute: () => applyVisualOperator('yank', true, ctx) }
    case 'r':
      return { next: { type: 'replace' } }
    case '~':
    case 'u':
    case 'U':
      return { execute: () => changeSelectionCase(input, ctx) }
    case 'p':
    case 'P':
      return { execute: () => pasteOverSelection(input === 'p', ctx) }
    case '>':
    case '<':
      return { execute: () => indentSelection(input, ctx) }
    case 'J':
      return { execute: () => joinSelection(ctx) }
    case 'o':
      return {
        execute: () => {
          const offset = ctx.cursor.offset
          ctx.setOffset(ctx.anchor)
          ctx.setVisual(offset, ctx.linewise)
        },
      }
    case 'v':
    case 'V': {
      const linewise = input === 'V'
      return {
        execute: () =>
          linewise === ctx.linewise
            ? ctx.exitVisual()
            : ctx.setVisual(ctx.anchor, linewise),
      }
    }
  }
  return {}
}

function selectionRange(ctx: VisualContext, linewise = ctx.linewise) {
  return getVisualRange(ctx.text, ctx.anchor, ctx.cursor.offset, linewise)
}

function maxCursorOffset(text: string): number {
  return Math.max(0, text.length - (lastGrapheme(text).length || 1))
}

function firstNonBlankOfLineAt(text: string, offset: number): number {
  const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0].length ?? 0
  return Math.min(lineStart + indent, maxCursorOffset(text))
}

function lineIndexAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length - 1
}

function applyVisualOperator(
  op: Operator,
  forceLinewise: boolean,
  ctx: VisualContext,
): void {
  const linewise = ctx.linewise || forceLinewise
  const { text } = ctx
  const range = selectionRange(ctx, linewise)
  const to = range.to
  let from = range.from
  let content = text.slice(from, to)
  if (linewise && !content.endsWith('\n')) content += '\n'
  ctx.setRegister(content, linewise)

  if (op === 'yank') {
    ctx.setOffset(from)
    ctx.exitVisual()
    return
  }

  if (op === 'change') {
    // Changing whole lines leaves one empty line to type into.
    const keptNewline = linewise && text[to - 1] === '\n' ? '\n' : ''
    ctx.setText(text.slice(0, from) + keptNewline + text.slice(to))
    ctx.enterInsert(from)
    return
  }

  // Deleting the last lines also removes the newline before them.
  if (linewise && to === text.length && from > 0 && text[from - 1] === '\n') {
    from -= 1
  }
  const newText = text.slice(0, from) + text.slice(to)
  ctx.setText(newText)
  ctx.setOffset(
    linewise
      ? firstNonBlankOfLineAt(newText, Math.min(from, newText.length))
      : Math.min(from, maxCursorOffset(newText)),
  )
  ctx.exitVisual()
}

function replaceSelection(char: string, ctx: VisualContext): void {
  const { from, to } = selectionRange(ctx)
  const segment = ctx.text.slice(from, to)
  const replaced = [...segment]
    .map(ch => (ch === '\n' ? ch : char))
    .join('')
  ctx.setText(ctx.text.slice(0, from) + replaced + ctx.text.slice(to))
  ctx.setOffset(from)
  ctx.exitVisual()
}

function changeSelectionCase(kind: '~' | 'u' | 'U', ctx: VisualContext): void {
  const { from, to } = selectionRange(ctx)
  const segment = ctx.text.slice(from, to)
  const changed =
    kind === 'u'
      ? segment.toLowerCase()
      : kind === 'U'
        ? segment.toUpperCase()
        : [...segment]
            .map(ch =>
              ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
            )
            .join('')
  ctx.setText(ctx.text.slice(0, from) + changed + ctx.text.slice(to))
  ctx.setOffset(from)
  ctx.exitVisual()
}

function pasteOverSelection(swapRegister: boolean, ctx: VisualContext): void {
  const register = ctx.getRegister()
  if (!register) return
  const registerLinewise = register.endsWith('\n')
  const { text, linewise } = ctx
  const { from, to } = selectionRange(ctx)
  let replacement: string
  if (linewise) {
    replacement = registerLinewise ? register : register + '\n'
    if (text[to - 1] !== '\n') replacement = replacement.slice(0, -1)
  } else {
    replacement = registerLinewise ? register.slice(0, -1) : register
  }

  if (swapRegister) {
    const deleted = text.slice(from, to)
    ctx.setRegister(
      linewise && !deleted.endsWith('\n') ? deleted + '\n' : deleted,
      linewise,
    )
  }
  const newText = text.slice(0, from) + replacement + text.slice(to)
  ctx.setText(newText)
  ctx.setOffset(
    linewise
      ? firstNonBlankOfLineAt(newText, Math.min(from, newText.length))
      : Math.min(
          from + replacement.length - (lastGrapheme(replacement).length || 1),
          maxCursorOffset(newText),
        ),
  )
  ctx.exitVisual()
}

function cursorAtSelectionStart(ctx: VisualContext): VisualContext {
  const start = Math.min(ctx.anchor, ctx.cursor.offset)
  return { ...ctx, cursor: new Cursor(ctx.cursor.measuredText, start) }
}

function selectedLineCount(ctx: VisualContext): number {
  return (
    lineIndexAt(ctx.text, Math.max(ctx.anchor, ctx.cursor.offset)) -
    lineIndexAt(ctx.text, Math.min(ctx.anchor, ctx.cursor.offset)) +
    1
  )
}

function indentSelection(dir: '>' | '<', ctx: VisualContext): void {
  executeIndent(dir, selectedLineCount(ctx), cursorAtSelectionStart(ctx))
  ctx.exitVisual()
}

function joinSelection(ctx: VisualContext): void {
  // J on a single-line selection still joins it with the next line.
  executeJoin(Math.max(1, selectedLineCount(ctx) - 1), cursorAtSelectionStart(ctx))
  ctx.exitVisual()
}

function selectTextObject(
  objType: string,
  scope: 'inner' | 'around',
  ctx: VisualContext,
): void {
  const range = findTextObject(
    ctx.text,
    ctx.cursor.offset,
    objType,
    scope === 'inner',
  )
  if (!range || range.end <= range.start) return
  const last =
    range.end - (lastGrapheme(ctx.text.slice(range.start, range.end)).length || 1)
  ctx.setOffset(last)
  ctx.setVisual(range.start, ctx.linewise)
}
