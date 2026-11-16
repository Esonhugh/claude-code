import type { Tool, ToolPermissionContext, Tools } from '../../Tool.js'
import { getIsNonInteractiveSession, getIsRemoteMode } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { getPlatform } from '../../utils/platform.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { CODE_MODE_ONLY_TOOLS, POLL_TOOL_NAME, REPL_TOOL_NAME } from './constants.js'

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

/** How to start a session with the variable set (official iZ). */
function withCodeModeEnv(value: 0 | 1): string {
  return getPlatform() === 'windows'
    ? `set the environment variable ${CODE_MODE_ENV} to ${value}, then run claude`
    : `${CODE_MODE_ENV}=${value} claude`
}

/**
 * Stands in for the Claude in Chrome prompt while Code Mode is on: the API
 * does not yet add its safety rules for Chrome or computer use there
 * (official Fde, me).
 */
export function codeModeChromeUnavailableText(): string {
  return `Claude in Chrome and computer use are not available while this session is in ${CODE_MODE_DISPLAY_NAME}, where the API does not yet add its safety rules for them. If the user asks for either, tell them why, and this: To use them, exit and start a new session with Code Mode off: ${withCodeModeEnv(0)} (add --chrome, if you started with it). This conversation can only be continued in Code Mode.`
}

const REMOTE_CONTROL_RESTART_HINT = `To use Remote Control, quit Claude Code and start it again with ${CODE_MODE_ENV} set to 0.`

/**
 * Why Remote Control can't be turned on, or null. A Code Mode session keeps
 * Code Mode and refuses the bridge (official wun/qjs, reason `repl_mode`).
 */
export function codeModeRemoteControlRefusal(): string | null {
  if (!getProcessCodeModeState().enabled) return null
  return `Remote Control isn't available in ${CODE_MODE_DISPLAY_NAME} yet. ${REMOTE_CONTROL_RESTART_HINT}`
}

/**
 * The startup notice for a Code Mode session whose Remote Control default is
 * on: Code Mode stays on and the bridge does not connect (official zfa,
 * notice `code-mode-remote-control`).
 */
export function codeModeRemoteControlNotConnectedText(): string {
  return `Remote Control isn't available in ${CODE_MODE_DISPLAY_NAME} yet, so this session isn't connected. ${REMOTE_CONTROL_RESTART_HINT}`
}

/**
 * What main.tsx knows once startup has settled the session's shape. Remote
 * Control is the user's ask on the command line (--rc, or an assistant
 * session, which always runs the bridge); a reattached bridge child counts
 * too. The remoteControlAtStartup default does not: official keeps Code Mode
 * on and refuses the bridge instead. The tool pool is built before the
 * bridge entitlement check, so a refused --rc still leaves Code Mode off.
 */
export type CodeModeStartup = { remoteControl: boolean; remote: boolean }

let startup: CodeModeStartup | undefined
let settled: CodeModeState | undefined

function startedWithRemoteControl(): boolean {
  if (process.env.CLAUDE_BRIDGE_REATTACH_SESSION !== undefined) return true
  if (startup) return startup.remoteControl
  return process.argv.some(arg => arg === '--remote-control' || arg === '--rc' || arg.startsWith('--remote-control=') || arg.startsWith('--rc='))
}

// Session modules are required lazily: this module is imported by tools.ts,
// the API client and tool execution, and those modules' import graphs loop
// back into the tool registry.
/* eslint-disable @typescript-eslint/no-require-imports */
function isUnattendedSession(): boolean {
  const { getSessionKind } = require('../../utils/concurrentSessions.js') as typeof import('../../utils/concurrentSessions.js')
  // A tmux teammate is its own process, so it decides here. An in-process
  // teammate shares this process and is refused per context instead.
  const { getDynamicTeamContext } = require('../../utils/teammate.js') as typeof import('../../utils/teammate.js')
  const team = getDynamicTeamContext()
  return getSessionKind() !== 'interactive' || !!(team?.agentId && team.teamName) || startedWithRemoteControl()
}

function isInProcessTeammateContext(): boolean {
  return (require('../../utils/teammateContext.js') as typeof import('../../utils/teammateContext.js')).isInProcessTeammate()
}
/* eslint-enable @typescript-eslint/no-require-imports */

function decideCodeMode(): CodeModeState {
  const value = process.env[CODE_MODE_ENV]
  if (value === undefined || value === '' || isEnvDefinedFalsy(value)) return { enabled: false }
  if (!isEnvTruthy(value)) return { enabled: false, reason: 'bad_value' }
  if (process.env.CLAUDE_CODE_REMOTE || process.env.ANTHROPIC_UNIX_SOCKET !== undefined) return { enabled: false, reason: 'entrypoint' }
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'cli' || getIsNonInteractiveSession() || getIsRemoteMode() || startup?.remote) return { enabled: false, reason: 'entrypoint' }
  if (isUnattendedSession()) return { enabled: false, reason: 'unattended' }
  return { enabled: true }
}

/**
 * The process-wide decision. It is pinned once main.tsx has called
 * settleCodeModeGate(); until then each call decides afresh, so a call made
 * before interactivity and Remote Control are known cannot fix a wrong answer.
 */
export function getProcessCodeModeState(): CodeModeState {
  if (settled) return settled
  const state = decideCodeMode()
  if (startup) {
    if (state.enabled) logForDebugging(`[CodeMode] ${CODE_MODE_DISPLAY_NAME} is on`)
    else if ('reason' in state && state.reason) logForDebugging(`[CodeMode] ${codeModeUnavailableMessage(state.reason)}`)
    settled = state
  }
  return state
}

/**
 * Called by main.tsx after setIsInteractive() and the Remote Control ask,
 * before the first tool pool is built. Later changes to the variable need a
 * new session.
 */
export function settleCodeModeGate(state: CodeModeStartup): CodeModeState {
  startup = state
  settled = undefined
  return getProcessCodeModeState()
}

const IN_PROCESS_TEAMMATE_REFUSAL: CodeModeState = { enabled: false, reason: 'unattended' }

/**
 * The decision for the current async context. In-process teammates share the
 * process but keep the ordinary tools (D3), so they are refused here.
 */
export function getCodeModeState(): CodeModeState {
  const state = getProcessCodeModeState()
  if (state.enabled && isInProcessTeammateContext()) return IN_PROCESS_TEAMMATE_REFUSAL
  return state
}

export function isCodeModeEnabled(): boolean {
  return getCodeModeState().enabled
}

export function resetCodeModeGateForTesting(): void {
  startup = undefined
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
  return `${name} is only available inside REPL. Use REPL with code: await ${name}({...}).`
}

/**
 * Suffix for "No such tool available: X" when X is one of the tools Code Mode
 * took out of the pool (CODE_MODE_ONLY_TOOLS, official). Any other name keeps
 * the ordinary answer.
 */
export function codeModeOnlyToolSuffix(toolName: string, sessionToolNames: readonly string[]): string {
  if (!isCodeModeEnabled() || !sessionToolNames.includes(REPL_TOOL_NAME)) return ''
  if (!CODE_MODE_ONLY_TOOLS.has(toolName)) return ''
  return `. ${codeModeOnlyToolError(toolName)}`
}

/**
 * A model call to a CODE_MODE_ONLY_TOOLS tool that is still in the pool. As in
 * official, Write, Edit, MCP and the other tools that stay in the pool run
 * when called directly, even though the API does not list them. Script and
 * Mods host calls pass through.
 */
export function codeModeRefusesDirectCall(
  tool: Tool,
  tools: Tools,
  context: { innerCall?: boolean; modToolCallResult?: unknown },
): boolean {
  if (context.innerCall === true || context.modToolCallResult !== undefined) return false
  return tool.isMcp !== true && CODE_MODE_ONLY_TOOLS.has(tool.name) && codeModeHidesTools(tools)
}

/**
 * A tool pool built for this Code Mode session, handed to a context where Code
 * Mode is refused (an in-process teammate): REPL and Poll come out and the
 * tools Code Mode removed come back, as the ordinary pool would have them.
 */
export function withoutCodeModeTools(tools: Tools, permissionContext: ToolPermissionContext): Tools {
  if (!getProcessCodeModeState().enabled || isCodeModeEnabled()) return tools
  if (!tools.some(tool => tool.isMcp !== true && hasName(tool, REPL_TOOL_NAME))) return tools
  const kept = tools.filter(
    tool => tool.isMcp === true || !(hasName(tool, REPL_TOOL_NAME) || hasName(tool, POLL_TOOL_NAME)),
  )
  const names = new Set(kept.map(tool => tool.name))
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getTools } = require('../../tools.js') as typeof import('../../tools.js')
  const restored = getTools(permissionContext).filter(
    tool => CODE_MODE_ONLY_TOOLS.has(tool.name) && !names.has(tool.name),
  )
  return [...kept, ...restored]
}
