import * as React from 'react'
import { createContext, useContext } from 'react'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolUseLoader } from '../../components/ToolUseLoader.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { Tool } from '../../Tool.js'
import { escapeControlCharacters } from '../../utils/sanitization.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'

/**
 * Official `v7t` (2.1.325 chunk-ff3rf65n.js): set while the transcript of a
 * Code Mode session is on screen; `all` while ctrl+e shows everything.
 */
export const ScriptSourceContext = createContext<{ all: boolean } | null>(null)

// Official chunk-eh1rf8gd.js: the code sits under ⎿ with this many columns taken.
const CODE_INSET = 6
const INVISIBLE = /[\p{Cs}\p{Co}\p{Cn}\u2800\u{E0020}-\u{E007F}]|(?!\u0020)\p{Zs}/gu
const JOINER_RUN = /[\uFE0E\uFE0F\u200D]{2,}/g
const KEPT_JOINERS = /^[\uFE0E\uFE0F]?\u200D?/

function codePointEscape(char: string): string {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`
}

/** Official `U`: shows control, invisible and unusual space characters as escapes. */
export function escapeScriptText(text: string): string {
  return escapeControlCharacters(text)
    .replace(INVISIBLE, codePointEscape)
    .replace(JOINER_RUN, run => {
      const kept = KEPT_JOINERS.exec(run)?.[0] ?? ''
      return kept + Array.from(run.slice(kept.length), codePointEscape).join('')
    })
}

/** Official `k7t`: the script of a REPL input, unless it is blank. */
export function scriptCode(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('code' in input)) return undefined
  const { code } = input
  return typeof code === 'string' && code.trim() !== '' ? code : undefined
}

/** The script as the transcript shows it. */
export function scriptSourceText(code: string): string {
  return escapeScriptText(code.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '$&\n')).trimEnd()
}

type Props = {
  tool: Tool
  input: unknown
  output: unknown
  shouldAnimate: boolean
  isUnresolved: boolean
  isError: boolean
  addMargin: boolean
}

/**
 * Official `ScriptSourceRow`: a REPL call in the transcript. Collapsed, it shows
 * the summary and the script's line count; ctrl+e shows the script itself.
 */
export function ScriptSourceRow({
  tool,
  input,
  output,
  shouldAnimate,
  isUnresolved,
  isError,
  addMargin,
}: Props): React.ReactNode {
  const transcript = useContext(ScriptSourceContext)
  const { columns } = useTerminalSize()
  const showAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')
  const code = scriptCode(input)
  if (transcript === null || code === undefined) return null

  const parsed = tool.inputSchema.safeParse(input)
  const data = parsed.success ? parsed.data : undefined
  const summary = data === undefined ? null : (tool.getToolUseSummary?.(data) ?? null)
  const source = scriptSourceText(code)
  const lineCount = countCharInString(source, '\n') + 1
  // A dispatched script is still running in the background.
  const dispatched =
    typeof output === 'object' && output !== null && 'asyncDispatched' in output && output.asyncDispatched === true
  const expanded = transcript.all

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      <Box flexDirection="row">
        <ToolUseLoader
          shouldAnimate={shouldAnimate && !dispatched}
          isUnresolved={isUnresolved || dispatched}
          isError={isError}
        />
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">
            {tool.userFacingName(data)}
          </Text>
        </Box>
        <Text>
          {summary !== null && `(${escapeScriptText(summary)})`}
          {!expanded && (
            <Text dimColor>{` · ${lineCount} ${plural(lineCount, 'line')} (${showAllShortcut} to show)`}</Text>
          )}
        </Text>
      </Box>
      {expanded && (
        <MessageResponse>
          <HighlightedCode code={source} filePath="script.js" width={columns - CODE_INSET} lineNumbers={false} />
        </MessageResponse>
      )}
    </Box>
  )
}
