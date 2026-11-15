import type { Tool, Tools } from '../../Tool.js'
import { getIsNonInteractiveSession, getIsRemoteMode } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { POLL_TOOL_NAME, REPL_PRIMITIVE_TOOL_NAMES, REPL_TOOL_NAME } from './constants.js'

export const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'
export const CODE_MODE_DISPLAY_NAME = 'Code Mode (experimental)'

export type CodeModeRefusal = 'bad_value' | 'entrypoint' | 'unattended'

export type CodeModeState =
  | { enabled: true }
  | { enabled: false; reason?: CodeModeRefusal }

/** Wording follows the official refusal text (2.1.325 chunk-yw5xfhrq.js). */
export function codeModeRefusalText(reason: CodeModeRefusal): string {
  switch (reason) {
    case 'bad_value':
      return `${CODE_MODE_ENV} must be 1 to turn it on`
    case 'entrypoint':
      return 'for now it only works in the interactive terminal'
    case 'unattended':
      return "for now it doesn't work in background jobs, in teammates' panes or with Remote Control"
  }
}

export function codeModeUnavailableMessage(reason: CodeModeRefusal): string {
  return `${CODE_MODE_DISPLAY_NAME} isn't available: ${codeModeRefusalText(reason)}. Starting with the ordinary tools.`
}

function startedWithRemoteControl(): boolean {
  if (process.env.CLAUDE_BRIDGE_REATTACH_SESSION !== undefined) return true
  if (process.argv.some(arg => arg === '--remote-control' || arg === '--rc' || arg.startsWith('--remote-control=') || arg.startsWith('--rc='))) return true
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRemoteControlAtStartup } = require('../../utils/config.js') as typeof import('../../utils/config.js')
  return getRemoteControlAtStartup()
}

// Session modules are required lazily: this module is imported by tools.ts,
// the API client and tool execution, and those modules' import graphs loop
// back into the tool registry.
/* eslint-disable @typescript-eslint/no-require-imports */
function isUnattendedSession(): boolean {
  const { getSessionKind } = require('../../utils/concurrentSessions.js') as typeof import('../../utils/concurrentSessions.js')
  const { isTeammate } = require('../../utils/teammate.js') as typeof import('../../utils/teammate.js')
  return getSessionKind() !== 'interactive' || isTeammate() || startedWithRemoteControl()
}
/* eslint-enable @typescript-eslint/no-require-imports */

function decideCodeMode(): CodeModeState {
  const value = process.env[CODE_MODE_ENV]
  if (value === undefined || value === '' || isEnvDefinedFalsy(value)) return { enabled: false }
  if (!isEnvTruthy(value)) return { enabled: false, reason: 'bad_value' }
  if (process.env.CLAUDE_CODE_REMOTE || process.env.ANTHROPIC_UNIX_SOCKET !== undefined) return { enabled: false, reason: 'entrypoint' }
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'cli' || getIsNonInteractiveSession() || getIsRemoteMode()) return { enabled: false, reason: 'entrypoint' }
  if (isUnattendedSession()) return { enabled: false, reason: 'unattended' }
  return { enabled: true }
}

let settled: CodeModeState | undefined

/** Decided once, on first use after startup; changing the variable later needs a new session. */
export function getCodeModeState(): CodeModeState {
  if (settled) return settled
  const state = decideCodeMode()
  if (state.enabled) logForDebugging(`[CodeMode] ${CODE_MODE_DISPLAY_NAME} is on`)
  else if ('reason' in state && state.reason) logForDebugging(`[CodeMode] ${codeModeUnavailableMessage(state.reason)}`)
  settled = state
  return state
}

export function isCodeModeEnabled(): boolean {
  return getCodeModeState().enabled
}

export function resetCodeModeGateForTesting(): void {
  settled = undefined
}

function hasName(tool: Pick<Tool, 'name' | 'aliases'>, name: string): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

/**
 * Tools sent to the API while Code Mode is on; everything else is called from
 * scripts. StructuredOutput is SYNTHETIC_OUTPUT_TOOL_NAME, spelled out because
 * that module is heavy.
 */
const API_VISIBLE_TOOL_NAMES: readonly string[] = [REPL_TOOL_NAME, POLL_TOOL_NAME, 'StructuredOutput']

/** Code Mode hides tools from the API only when the REPL tool itself survived tool filtering. */
export function codeModeHidesTools(tools: Tools): boolean {
  return isCodeModeEnabled() && tools.some(tool => tool.isMcp !== true && hasName(tool, REPL_TOOL_NAME))
}

export function isHiddenByCodeMode(tool: Tool): boolean {
  if (tool.isMcp === true) return true
  return !API_VISIBLE_TOOL_NAMES.some(name => hasName(tool, name))
}

export function hideCodeModeOnlyTools(tools: Tools): Tools {
  if (!codeModeHidesTools(tools)) return tools
  const visible = tools.filter(tool => !isHiddenByCodeMode(tool))
  return visible.length === tools.length ? tools : visible
}

/** Answer for a model that calls a hidden tool directly instead of from a script. */
export function codeModeOnlyToolError(name: string): string {
  return `${name} is only available inside REPL. Use REPL with code: await ${name}({...})`
}

/**
 * Suffix for "No such tool available: X" when X is a Code Mode tool the model
 * called directly. Only names a script can reach get it; an unknown name
 * keeps the ordinary answer.
 */
export function codeModeOnlyToolSuffix(toolName: string, sessionToolNames: readonly string[]): string {
  if (!isCodeModeEnabled() || !sessionToolNames.includes(REPL_TOOL_NAME)) return ''
  if (API_VISIBLE_TOOL_NAMES.includes(toolName)) return ''
  if (!REPL_PRIMITIVE_TOOL_NAMES.has(toolName) && !sessionToolNames.includes(toolName)) return ''
  return `. ${codeModeOnlyToolError(toolName)}`
}

/**
 * A model call to a tool that is still in the pool but hidden from the API
 * (Write, Edit, MCP, ...). Script and Mods host calls pass through.
 */
export function codeModeRefusesDirectCall(
  tool: Tool,
  tools: Tools,
  context: { innerCall?: boolean; modToolCallResult?: unknown },
): boolean {
  if (context.innerCall === true || context.modToolCallResult !== undefined) return false
  return codeModeHidesTools(tools) && isHiddenByCodeMode(tool)
}
