import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import {
  getOriginalCwd,
  getSdkBetas,
  getSessionId,
} from 'src/bootstrap/state.js'
import { DEFAULT_OUTPUT_STYLE_NAME } from 'src/constants/outputStyles.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memdir/paths.js'
import type {
  ApiKeySource,
  PermissionMode,
  SDKMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
} from 'src/tools/AgentTool/constants.js'
import { getAnthropicApiKeyWithSource } from '../auth.js'
import { getCwd } from '../cwd.js'
import { isAnalyticsDisabled } from '../../services/analytics/config.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { getFastModeDisabledReason, getFastModeState } from '../fastMode.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'

// TODO(next-minor): remove this translation once SDK consumers have migrated
// to the 'Agent' tool name. The wire name was renamed Task → Agent in #19647,
// but emitting the new name in init/result events broke SDK consumers on a
// patch-level release. Keep emitting 'Task' until the next minor.
export function sdkCompatToolName(name: string): string {
  return name === AGENT_TOOL_NAME ? LEGACY_AGENT_TOOL_NAME : name
}

// Control-protocol features print.ts implements (interrupt replies carry
// still_queued; mcp_read_resource reads ui:// resources).
export const SDK_INIT_CAPABILITIES = [
  'interrupt_receipt_v1',
  'mcp_read_resource_v1',
] as const

type CommandLike = {
  name: string
  userInvocable?: boolean
  terminalOriented?: boolean
}

export type SystemInitInputs = {
  tools: ReadonlyArray<{ name: string }>
  mcpClients: ReadonlyArray<{
    name: string
    type: string
    config?: { type?: string; scope?: string; pluginSource?: string }
  }>
  model: string
  permissionMode: PermissionMode
  commands: ReadonlyArray<CommandLike>
  agents: ReadonlyArray<{ agentType: string }>
  skills: ReadonlyArray<CommandLike>
  plugins: ReadonlyArray<{ name: string; path: string; source: string }>
  fastMode: boolean | undefined
  additionalDirectories?: readonly string[]
  capabilities?: readonly string[]
}

// Official 2.1.311 McpServerStatus.source: sdk | plugin | the config scope.
function mcpServerSource(config: {
  type?: string
  scope?: string
  pluginSource?: string
}): string | undefined {
  if (config.type === 'sdk') return 'sdk'
  if (config.pluginSource !== undefined) return 'plugin'
  return config.scope
}

/**
 * Build the `system/init` SDKMessage — the first message on the SDK stream
 * carrying session metadata (cwd, tools, model, commands, etc.) that remote
 * clients use to render pickers and gate UI.
 *
 * Called from two paths that must produce identical shapes:
 *   - QueryEngine (spawn-bridge / print-mode / SDK) — yielded as the first
 *     stream message per query turn
 *   - useReplBridge (REPL Remote Control) — sent via writeSdkMessages() on
 *     bridge connect, since REPL uses query() directly and never hits the
 *     QueryEngine SDKMessage layer
 */
export function buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage {
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  const initMessage: SDKMessage = {
    type: 'system',
    subtype: 'init',
    cwd: getCwd(),
    session_id: getSessionId(),
    tools: inputs.tools.map(tool => sdkCompatToolName(tool.name)),
    mcp_servers: inputs.mcpClients.map(client => {
      const source = client.config && mcpServerSource(client.config)
      return {
        name: client.name,
        status: client.type,
        ...(source !== undefined && { source }),
      }
    }),
    model: inputs.model,
    permissionMode: inputs.permissionMode,
    slash_commands: inputs.commands
      .filter(c => c.userInvocable !== false)
      .map(c => c.name),
    apiKeySource: getAnthropicApiKeyWithSource().source as ApiKeySource,
    betas: getSdkBetas(),
    claude_code_version: MACRO.VERSION,
    output_style: outputStyle,
    agents: inputs.agents
      .map(agent => agent.agentType)
      .sort((a, b) => a.localeCompare(b)),
    skills: inputs.skills
      .filter(s => s.userInvocable !== false)
      .map(skill => skill.name),
    plugins: inputs.plugins.map(plugin => ({
      name: plugin.name,
      path: plugin.path,
      source: plugin.source,
    })),
    uuid: randomUUID(),
  }
  const terminalSlashCommands = inputs.commands
    .filter(c => c.userInvocable !== false && c.terminalOriented === true)
    .map(c => c.name)
  if (terminalSlashCommands.length > 0) {
    initMessage.terminal_slash_commands = terminalSlashCommands
  }
  if (inputs.capabilities?.length) {
    initMessage.capabilities = [...inputs.capabilities]
  }
  if (isAutoMemoryEnabled()) {
    initMessage.memory_paths = { auto: getAutoMemPath() }
  }
  initMessage.original_cwd = getOriginalCwd()
  // Hidden from public SDK types — ant-only UDS messaging socket path
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(initMessage as Record<string, unknown>).messaging_socket_path =
      require('../udsMessaging.js').getUdsMessagingSocketPath()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  if (inputs.additionalDirectories !== undefined) {
    initMessage.additional_directories = [...inputs.additionalDirectories]
  }
  initMessage.fast_mode_state = getFastModeState(inputs.model, inputs.fastMode)
  const fastModeDisabledReason = getFastModeDisabledReason()
  if (fastModeDisabledReason !== null) {
    initMessage.fast_mode_disabled_reason = fastModeDisabledReason
  }
  // This build sends effort only as the top-level parameter and has no
  // focus view.
  initMessage.per_turn_effort_active = false
  initMessage.view_mode = 'default'
  initMessage.analytics_disabled = isAnalyticsDisabled()
  initMessage.product_feedback_disabled = !isPolicyAllowed(
    'allow_product_feedback',
  )
  return initMessage
}
