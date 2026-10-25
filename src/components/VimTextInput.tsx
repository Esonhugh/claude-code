import chalk from 'chalk'
import React from 'react'
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js'
import { useVimInput } from '../hooks/useVimInput.js'
import { Box, color, useTerminalFocus, useTheme } from '../ink.js'
import type { VimTextInputProps } from '../types/textInputTypes.js'
import { firstGrapheme } from '../utils/intl.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
import { getVisualRange } from '../vim/visual.js'
import { BaseTextInput } from './BaseTextInput.js'

export type Props = VimTextInputProps & {
  highlights?: TextHighlight[]
}

export default function VimTextInput(props: Props): React.ReactNode {
  const [theme] = useTheme()
  const isTerminalFocused = useTerminalFocus()

  // Show hint when terminal regains focus and clipboard has an image
  useClipboardImageHint(isTerminalFocused, !!props.onImagePaste)

  const vimInputState = useVimInput({
    value: props.value,
    onChange: props.onChange,
    onEdit: props.onEdit,
    getInputBox: props.getInputBox,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onExitMessage: props.onExitMessage,
    onHistoryReset: props.onHistoryReset,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onClearInput: props.onClearInput,
    focus: props.focus,
    mask: props.mask,
    multiline: props.multiline,
    cursorChar: props.showCursor ? ' ' : '',
    highlightPastedText: props.highlightPastedText,
    invert: isTerminalFocused ? chalk.inverse : (text: string) => text,
    themeText: color('text', theme),
    columns: props.columns,
    maxVisibleLines: props.maxVisibleLines,
    onImagePaste: props.onImagePaste,
    disableCursorMovementForUpDownKeys:
      props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    inputFilter: props.inputFilter,
    onModeChange: props.onModeChange,
    onUndo: props.onUndo,
  })

  const { mode, setMode, visualAnchor } = vimInputState

  React.useEffect(() => {
    if (props.initialMode && props.initialMode !== mode) {
      setMode(props.initialMode)
    }
  }, [props.initialMode, mode, setMode])

  // BaseTextInput drops highlights that cover the cursor, so the selection is
  // split around the cursor cell, which is already drawn inverted.
  const highlights = React.useMemo((): TextHighlight[] | undefined => {
    if (visualAnchor === null) return props.highlights
    const { from, to } = getVisualRange(
      props.value,
      visualAnchor,
      props.cursorOffset,
      mode === 'VISUAL LINE',
    )
    const cursorEnd =
      props.cursorOffset +
      (firstGrapheme(props.value.slice(props.cursorOffset)).length || 1)
    const selection: TextHighlight[] = [
      { start: from, end: Math.min(props.cursorOffset, to) },
      { start: Math.max(cursorEnd, from), end: to },
    ]
      .filter(range => range.end > range.start)
      .map(range => ({ ...range, color: undefined, inverse: true, priority: 30 }))
    return [...(props.highlights ?? []), ...selection]
  }, [visualAnchor, mode, props.value, props.cursorOffset, props.highlights])

  return (
    <Box flexDirection="column">
      <BaseTextInput
        inputState={vimInputState}
        terminalFocus={isTerminalFocused}
        {...props}
        highlights={highlights}
      />
    </Box>
  )
}
