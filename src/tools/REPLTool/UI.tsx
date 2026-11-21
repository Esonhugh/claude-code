import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'

/** REPL is a transparent wrapper: the calls its script makes render as their own tool messages. */
export function renderToolUseMessage(): React.ReactNode {
  return ''
}

const TIMED_OUT = /^Error: REPL execution timed out after (\d+)ms/
const SYNTAX_ERROR = 'Syntax error, so nothing ran'
const REFUSED = /^error: /

/** Official `yl` with `Tl`: the line people see for a script-time timeout. */
function timedOutLine(ms: number): string {
  const time = ms < 60_000 ? `${Number((ms / 1000).toFixed(3))}s` : formatDuration(ms, { hideTrailingZeros: true })
  return `Timed out after ${time}, not counting time spent in tool calls`
}

/** Official `plainErrorLine`: the one line people see for a script's own failure. */
export function replErrorLine(error: string): string {
  const ms = TIMED_OUT.exec(error)?.[1]
  if (ms !== undefined) return timedOutLine(Number(ms))
  return error.startsWith(SYNTAX_ERROR) ? SYNTAX_ERROR : error.split('\n', 1)[0]!
}

/**
 * The line under a call that failed: a script's own failure (the virtual
 * `repl-error-` call) or a refused dispatch, whose text opens with `error: `.
 * Errors worded for the model keep the standard row.
 */
export function renderToolUseErrorMessage(result: unknown): React.ReactNode {
  if (typeof result !== 'string' || result.includes('<tool_use_error>')) return null
  return (
    <MessageResponse>
      <Text color="error">{result.replace(REFUSED, '')}</Text>
    </MessageResponse>
  )
}
