import React, { useCallback, useState } from 'react'
import type { Key } from '../ink.js'
import type { VimInputState, VimMode } from '../types/textInputTypes.js'
import { Cursor } from '../utils/Cursor.js'
import { lastGrapheme } from '../utils/intl.js'
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
  type OperatorContext,
} from '../vim/operators.js'
import { type TransitionContext, transition } from '../vim/transitions.js'
import { transitionVisual, type VisualContext } from '../vim/visual.js'
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type RecordedChange,
  type VimState,
} from '../vim/types.js'
import { type UseTextInputProps, useTextInput } from './useTextInput.js'

type UseVimInputProps = Omit<UseTextInputProps, 'inputFilter'> & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
  inputFilter?: UseTextInputProps['inputFilter']
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = React.useRef<VimState>(createInitialVimState())
  const [mode, setMode] = useState<VimMode>('INSERT')
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null)

  const persistentRef = React.useRef<PersistentState>(
    createInitialPersistentState(),
  )
  const liveDraftRef = React.useRef({
    text: props.value,
    cursor: props.externalOffset,
  })
  React.useLayoutEffect(() => {
    liveDraftRef.current = { text: props.value, cursor: props.externalOffset }
  }, [props.value, props.externalOffset])

  function changeText(text: string, cursor = liveDraftRef.current.cursor) {
    const result = props.onChange(text, cursor)
    const accepted = typeof result === 'object' && result ? result : undefined
    const value = typeof result === 'string' ? result : accepted?.value ?? text
    const offset = accepted?.cursorOffset ?? cursor
    liveDraftRef.current = {
      text: value,
      cursor: Math.max(0, Math.min(offset, value.length)),
    }
    return result
  }
  function setOffset(cursor: number) {
    liveDraftRef.current.cursor = cursor
    props.onOffsetChange(cursor)
  }
  function readCursor() {
    const { text, cursor } = liveDraftRef.current
    return Cursor.fromText(text, props.columns, cursor)
  }

  // inputFilter is applied once at the top of handleVimInput (not here) so
  // vim-handled paths that return without calling textInput.onInput still
  // run the filter — otherwise a stateful filter (e.g. lazy-space-after-
  // pill) stays armed across an Escape → NORMAL → INSERT round-trip.
  const textInput = useTextInput({
    ...props,
    onChange: changeText,
    onOffsetChange: setOffset,
    getInputBox: () => liveDraftRef.current,
    inputFilter: undefined,
  })
  const { onModeChange, inputFilter } = props

  const switchToInsertMode = useCallback(
    (offset?: number): void => {
      if (offset !== undefined) {
        textInput.setOffset(offset)
      }
      vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      setMode('INSERT')
      setVisualAnchor(null)
      onModeChange?.('INSERT')
    },
    [textInput, onModeChange],
  )

  const setVisualMode = useCallback(
    (anchor: number, linewise: boolean): void => {
      vimStateRef.current = {
        mode: 'VISUAL',
        linewise,
        anchor,
        command: { type: 'idle' },
      }
      const visualMode = linewise ? 'VISUAL LINE' : 'VISUAL'
      setMode(visualMode)
      setVisualAnchor(anchor)
      onModeChange?.(visualMode)
    },
    [onModeChange],
  )

  const exitVisualMode = useCallback((): void => {
    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    setVisualAnchor(null)
    onModeChange?.('NORMAL')
  }, [onModeChange])

  const switchToNormalMode = useCallback((): void => {
    const current = vimStateRef.current
    if (current.mode === 'INSERT' && current.insertedText) {
      persistentRef.current.lastChange = {
        type: 'insert',
        text: current.insertedText,
      }
    }

    // Vim behavior: move one whole grapheme left when exiting insert mode
    // (unless at beginning of line or at offset 0)
    const { text, cursor: offset } = liveDraftRef.current
    const normalized = text.normalize('NFC')
    if (offset > 0 && normalized[offset - 1] !== '\n') {
      textInput.setOffset(
        offset - (offset > normalized.length ? 1 : lastGrapheme(normalized.slice(0, offset)).length),
      )
    }

    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    onModeChange?.('NORMAL')
  }, [onModeChange, textInput])

  function createOperatorContext(
    cursor: Cursor,
    isReplay: boolean = false,
  ): OperatorContext {
    return {
      cursor,
      text: cursor.text,
      setText: (newText: string) => changeText(newText),
      setOffset: (offset: number) => textInput.setOffset(offset),
      enterInsert: (offset: number) => switchToInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content: string, linewise: boolean) => {
        persistentRef.current.register = content
        persistentRef.current.registerIsLinewise = linewise
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char }
      },
      recordChange: isReplay
        ? () => {}
        : (change: RecordedChange) => {
            persistentRef.current.lastChange = change
          },
    }
  }

  function replayLastChange(): void {
    const change = persistentRef.current.lastChange
    if (!change) return

    const cursor = readCursor()
    const ctx = createOperatorContext(cursor, true)

    switch (change.type) {
      case 'insert':
        if (change.text) {
          const newCursor = cursor.insert(change.text)
          changeText(newCursor.text, newCursor.offset)
          textInput.setOffset(newCursor.offset)
        }
        break

      case 'x':
        executeX(change.count, ctx)
        break

      case 'replace':
        executeReplace(change.char, change.count, ctx)
        break

      case 'toggleCase':
        executeToggleCase(change.count, ctx)
        break

      case 'indent':
        executeIndent(change.dir, change.count, ctx)
        break

      case 'join':
        executeJoin(change.count, ctx)
        break

      case 'openLine':
        executeOpenLine(change.direction, ctx)
        break

      case 'operator':
        executeOperatorMotion(change.op, change.motion, change.count, ctx)
        break

      case 'operatorFind':
        executeOperatorFind(
          change.op,
          change.find,
          change.char,
          change.count,
          ctx,
        )
        break

      case 'operatorTextObj':
        executeOperatorTextObj(
          change.op,
          change.scope,
          change.objType,
          change.count,
          ctx,
        )
        break
    }
  }

  function executeNormalInput(input: string, cursor = readCursor()): void {
    const state = vimStateRef.current
    if (state.mode !== 'NORMAL') return
    const ctx: TransitionContext = {
      ...createOperatorContext(cursor, false),
      onUndo: props.onUndo,
      onDotRepeat: replayLastChange,
      enterVisual: linewise =>
        setVisualMode(liveDraftRef.current.cursor, linewise),
    }
    const result = transition(state.command, input, ctx)
    result.execute?.()
    if (vimStateRef.current.mode === 'NORMAL') {
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next }
      } else if (result.execute) {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
    }
  }

  function executeVisualInput(input: string, cursor: Cursor): void {
    const state = vimStateRef.current
    if (state.mode !== 'VISUAL') return
    const ctx: VisualContext = {
      ...createOperatorContext(cursor, false),
      anchor: state.anchor,
      linewise: state.linewise,
      exitVisual: exitVisualMode,
      setVisual: setVisualMode,
    }
    const result = transitionVisual(state.command, input, ctx)
    result.execute?.()
    const current = vimStateRef.current
    if (current.mode === 'VISUAL' && (result.next || result.execute)) {
      vimStateRef.current = {
        ...current,
        command: result.next ?? { type: 'idle' },
      }
    }
  }

  function executeNormalSequence(input: string): void {
    const characters = [...input]
    for (let index = 0; index < characters.length; index++) {
      const state = vimStateRef.current
      if (state.mode === 'INSERT') {
        const remainder = characters.slice(index).join('')
        const cursor = readCursor().insert(remainder)
        changeText(cursor.text, cursor.offset)
        textInput.setOffset(liveDraftRef.current.cursor)
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + remainder,
        }
        return
      }
      if (state.mode !== 'NORMAL') return
      executeNormalInput(characters[index]!)
    }
  }

  function handleVimInput(rawInput: string, key: Key): void {
    const inputBox = props.getInputBox?.()
    if (inputBox) liveDraftRef.current = { ...inputBox }
    const state = vimStateRef.current
    // Run inputFilter in all modes so stateful filters disarm on any key,
    // but only apply the transformed input in INSERT — NORMAL-mode command
    // lookups expect single chars and a prepended space would break them.
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    const input = state.mode === 'INSERT' ? filtered : rawInput
    const cursor = readCursor()

    if (key.ctrl || (key.meta && !key.escape)) {
      // Like Vim, a control key ends the selection instead of editing it.
      if (state.mode === 'VISUAL') {
        exitVisualMode()
        return
      }
      textInput.onInput(input, key)
      return
    }

    // NOTE(keybindings): This escape handler is intentionally NOT migrated to the keybindings system.
    // It's vim's standard INSERT->NORMAL mode switch - a vim-specific behavior that should not be
    // configurable via keybindings. Vim users expect Esc to always exit INSERT mode.
    if (key.escape && state.mode === 'INSERT') {
      switchToNormalMode()
      return
    }

    // Escape in NORMAL mode cancels any pending command (replace, operator, etc.)
    if (key.escape && state.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      return
    }

    if (state.mode === 'VISUAL') {
      if (key.escape) {
        if (state.command.type === 'idle') exitVisualMode()
        else vimStateRef.current = { ...state, command: { type: 'idle' } }
        return
      }
      const expectsMotion =
        state.command.type === 'idle' || state.command.type === 'count'
      let visualInput = input
      if (key.leftArrow) visualInput = expectsMotion ? 'h' : ''
      else if (key.rightArrow) visualInput = expectsMotion ? 'l' : ''
      else if (key.upArrow) visualInput = expectsMotion ? 'k' : ''
      else if (key.downArrow) visualInput = expectsMotion ? 'j' : ''
      else if (key.return) visualInput = expectsMotion ? 'j' : '\n'
      else if (key.backspace) visualInput = expectsMotion ? 'h' : ''
      else if (key.delete) {
        visualInput = expectsMotion && state.command.type !== 'count' ? 'x' : ''
      }
      if ([...visualInput].length > 1) return
      executeVisualInput(visualInput, cursor)
      return
    }

    // Pass Enter to base handler regardless of mode (allows submission from NORMAL)
    if (key.return) {
      textInput.onInput(input, key)
      return
    }

    if (state.mode === 'INSERT') {
      // Track inserted text for dot-repeat
      if (key.backspace || key.delete) {
        if (state.insertedText.length > 0) {
          vimStateRef.current = {
            mode: 'INSERT',
            insertedText: state.insertedText.slice(
              0,
              -(lastGrapheme(state.insertedText).length || 1),
            ),
          }
        }
      } else {
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + input,
        }
      }
      textInput.onInput(input, key)
      return
    }

    if (state.mode !== 'NORMAL') {
      return
    }

    // Keep ordinary history arrows and the empty-draft left action in the
    // base editor; other Normal arrows are Vim motions without edit relay.
    if (
      state.command.type === 'idle' && !key.shift &&
      (key.upArrow || key.downArrow || key.leftArrow && cursor.text === '')
    ) {
      textInput.onInput(input, key)
      return
    }

    // Backspace/Delete are only mapped in motion-expecting states. In
    // literal-char states (replace, find, operatorFind), mapping would turn
    // r+Backspace into "replace with h" and df+Delete into "delete to next x".
    // Delete additionally skips count state: in vim, N<Del> removes a count
    // digit rather than executing Nx; we don't implement digit removal but
    // should at least not turn a cancel into a destructive Nx.
    const expectsMotion =
      state.command.type === 'idle' ||
      state.command.type === 'count' ||
      state.command.type === 'operator' ||
      state.command.type === 'operatorCount'

    // Map arrow keys to vim motions in NORMAL mode
    let vimInput = input
    if (key.leftArrow) vimInput = 'h'
    else if (key.rightArrow) vimInput = 'l'
    else if (key.upArrow) vimInput = 'k'
    else if (key.downArrow) vimInput = 'j'
    else if (expectsMotion && key.backspace) vimInput = 'h'
    else if (expectsMotion && state.command.type !== 'count' && key.delete)
      vimInput = 'x'

    if ([...vimInput].length > 1) executeNormalSequence(vimInput)
    else executeNormalInput(vimInput, cursor)

    if (
      input === '?' &&
      state.mode === 'NORMAL' &&
      state.command.type === 'idle'
    ) {
      changeText('?')
    }
  }

  const setModeExternal = useCallback(
    (requestedMode: VimMode) => {
      // A selection cannot be restored from the mode name alone (it has no
      // anchor), so an external VISUAL request lands in NORMAL.
      const newMode = requestedMode === 'INSERT' ? 'INSERT' : 'NORMAL'
      if (newMode === 'INSERT') {
        vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      } else {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
      setMode(newMode)
      setVisualAnchor(null)
      onModeChange?.(newMode)
    },
    [onModeChange],
  )

  return {
    ...textInput,
    onInput: handleVimInput,
    mode,
    setMode: setModeExternal,
    visualAnchor,
  }
}
