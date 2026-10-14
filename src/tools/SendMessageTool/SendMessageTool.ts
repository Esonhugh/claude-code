import { randomUUID } from 'node:crypto'
import { createAssistantMessage } from '../../utils/messages.js'
import { isEqual } from 'lodash-es'
import { runModSessionSend, sessionSendToolResult } from '../../services/mods/sessionSend.js'
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import { readAgentMetadata } from '../../utils/sessionStorage.js'
import { resumeInProcessTeammate } from '../../utils/swarm/resumeInProcessTeammate.js'
import { generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from '../../utils/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { frameSubagentHandback, displaySubagentHandback, RESUMED_AGENT_MESSAGE, RESUMED_AGENT_FRAMED_MESSAGE, type SubagentHandback } from '../../utils/subagentHandback.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { AgentStoppedByUserError, cancelledAgentMessage } from '../../utils/agentCancellation.js'
import { bindSubagentRecipient, resolveSubagentRecipient, type SendMessagePin } from '../../utils/sendMessagePins.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const pendingTeammateResumes = new WeakMap<ToolUseContext['setAppState'], Map<string, Promise<string | null>>>()

const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        feature('UDS_INBOX')
          ? 'Recipient: agent or teammate name, "*" for team broadcast, or a local session name, "name [ref]", session UUID, or "uds:<socket-path>" (use ListAgents to discover)'
          : 'Recipient: teammate name, or "*" for broadcast to all teammates',
      ),
    summary: z
      .string()
      .optional()
      .describe('Optional 5-10 word summary shown as a preview in the UI'),
    message: z.union([
      z.string().describe('Plain text message content'),
      StructuredMessage(),
    ]),
  }),
)
const peerInputSchema = lazySchema(() => inputSchema().extend({
  to: z.string().describe('Agent name or local session name, "name [ref]", session UUID, or "uds:<socket-path>"'),
  message: z.string().describe('Plain text message content'),
}))
type InputSchema = ReturnType<typeof inputSchema> | ReturnType<typeof peerInputSchema>

export type Input = z.infer<InputSchema>

export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
  pin?: SendMessagePin
  display?: string
  inlineHandback?: SubagentHandback & { displayName: string }
}

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

async function handleMessage(
  recipientName: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
  teamNameOverride?: string,
): Promise<{ data: MessageOutput }> {
  const appState = context.getAppState()
  const teamName = teamNameOverride ?? getTeamName(appState.teamContext)
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  const delivered = await writeToMailbox(
    recipientName,
    {
      from: senderName,
      text: content,
      summary,
      timestamp: new Date().toISOString(),
      color: senderColor,
    },
    teamName,
  )
  if (delivered === false) return {data:{success:false,message:`Writing to ${recipientName}'s inbox failed; nothing was queued.`}}

  const recipientColor = findTeammateColor(appState, recipientName)

  return {
    data: {
      success: true,
      message: `Message sent to ${recipientName}'s inbox`,
      routing: {
        sender: senderName,
        senderColor,
        target: `@${recipientName}`,
        targetColor: recipientColor,
        summary,
        content,
      },
    },
  }
}

async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  if (!teamName) {
    throw new Error(
      'Not in a team context. Create a team with Teammate spawnTeam first, or set CLAUDE_CODE_TEAM_NAME.',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" does not exist`)
  }

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      'Cannot broadcast: sender name is required. Set CLAUDE_CODE_AGENT_NAME.',
    )
  }

  const senderColor = getTeammateColor()

  const recipients: string[] = []
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  const requestId = generateRequestId('shutdown', targetName)

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
            request_id: requestId,
          },
        }
      }
    }

    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can approve plans. Teammates cannot approve their own or other plans.',
    )
  }

  const leaderMode = appState.toolPermissionContext.mode
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`,
      request_id: requestId,
    },
  }
}

async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can reject plans. Teammates cannot reject their own or other plans.',
    )
  }

  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan rejected for ${recipientName} with feedback: "${feedback}"`,
      request_id: requestId,
    },
  }
}

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: 'send messages to agents, teammates, or local Claude sessions',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return isAgentSwarmsEnabled() ? inputSchema() : peerInputSchema()
    },
    shouldDefer: true,

    isEnabled() {
      if (feature('UDS_INBOX') && getUdsMessagingSocketPath() !== null) {
        return true
      }
      return isAgentSwarmsEnabled()
    },

    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    backfillObservableInput(input) {
      if ('type' in input) return
      if (typeof input.to !== 'string') return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = input.to
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = input.to
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    toAutoClassifierInput(input) {
      if (typeof input.message === 'string') {
        return `to ${input.to}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${input.to}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${input.to}`
      }
    },

    async checkPermissions(input, _context) {
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        return {
          behavior: 'ask' as const,
          message: `Send a message to Remote Control session ${input.to}? It arrives as a user prompt on the receiving Claude (possibly another machine) via Anthropic's servers.`,
          // safetyCheck (not mode) — permissions.ts guards this before both
          // bypassPermissions (step 1g) and auto-mode's allowlist/classifier.
          // Cross-machine prompt injection must stay bypass-immune.
          decisionReason: {
            type: 'safetyCheck',
            reason:
              'Cross-machine bridge message requires explicit user consent',
            classifierApprovable: false,
          },
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, _context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' || addr.scheme === 'uds') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      if (!feature('UDS_INBOX') && input.to.includes('@')) {
        return {
          result: false,
          message:
            'to must be a bare teammate name or "*" — there is only one team per session',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        // Structured-message rejection first — it's the permanent constraint.
        // Showing "not connected" first would make the user reconnect only to
        // hit this error on retry.
        if (typeof input.message !== 'string') {
          return {
            result: false,
            message:
              'structured messages cannot be sent cross-session — only plain text',
            errorCode: 9,
          }
        }
        // postInterClaudeMessage derives from= via getReplBridgeHandle() —
        // check handle directly for the init-timing window. Also check
        // isReplBridgeActive() to reject outbound-only (CCR mirror) mode
        // where the bridge is write-only and peer messaging is unsupported.
        if (!getReplBridgeHandle() || !isReplBridgeActive()) {
          return {
            result: false,
            message:
              'Remote Control is not connected — cannot send to a bridge: target. Reconnect with /remote-control first.',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (typeof input.message === 'string') {
        return { result: true }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme !== 'other') {
        return {
          result: false,
          message:
            'structured messages cannot be sent cross-session — only plain text',
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      const { display: _display, ...modelData } = data as SendMessageToolOutput & { display?: string }
      if ('inlineHandback' in modelData && modelData.inlineHandback) {
        const { inlineHandback, ...rest } = modelData
        const framed = process.env.CLAUDE_CODE_HANDBACK_PROVENANCE === undefined || isEnvTruthy(process.env.CLAUDE_CODE_HANDBACK_PROVENANCE)
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: [{ type: 'text' as const, text: framed
            ? jsonStringify({success:true,message:RESUMED_AGENT_FRAMED_MESSAGE}) + '\n' + frameSubagentHandback(inlineHandback.content, inlineHandback)
            : jsonStringify({...rest,message:displaySubagentHandback(inlineHandback.displayName,inlineHandback.content)}) }],
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(modelData),
          },
        ],
      }
    },

    async call(input, context, canUseTool, assistantMessage) {
      const send = async (input: z.infer<InputSchema>): Promise<{data:SendMessageToolOutput}> => {
      if (feature('UDS_INBOX') && typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'bridge') {
          // Re-check handle — checkPermissions blocks on user approval (can be
          // minutes). validateInput's check is stale if the bridge dropped
          // during the prompt wait; without this, from="unknown" ships.
          // Also re-check isReplBridgeActive for outbound-only mode.
          if (!getReplBridgeHandle() || !isReplBridgeActive()) {
            return {
              data: {
                success: false,
                message: `Remote Control disconnected before send — cannot deliver to ${input.to}`,
              },
            }
          }
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { postInterClaudeMessage } =
            require('../../bridge/peerSessions.js') as typeof import('../../bridge/peerSessions.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          const result = await postInterClaudeMessage(
            addr.target,
            input.message,
          )
          const preview = input.summary || truncate(input.message, 50)
          return {
            data: {
              success: result.ok,
              message: result.ok
                ? `“${preview}” → ${input.to}`
                : `Failed to send to ${input.to}: ${result.error ?? 'unknown'}`,
            },
          }
        }
        if (addr.scheme === 'uds') {
          if (!getUdsMessagingSocketPath()) {
            return {
              data: {
                success: false,
                message:
                  'Local session messaging is unavailable: no active IPC endpoint.',
              },
            }
          }
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { sendToUdsSocket } =
            require('../../utils/udsClient.js') as typeof import('../../utils/udsClient.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          try {
            const permissions = context.getAppState().toolPermissionContext
            await sendToUdsSocket(addr.target, input.message, {
                ...(context.modSpawnedBy ? {fromPlugin:context.modSpawnedBy} : {}),
                ...(context.abortController ? {signal:context.abortController.signal} : {}),
              fromMode:
                permissions.mode === 'bypassPermissions' ||
                (permissions.mode === 'plan' && permissions.isBypassPermissionsModeAvailable)
                  ? 'bypass'
                  : 'prompting',
            })
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `“${preview}” → ${input.to} (sent; acceptance and processing are not confirmed)`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send to ${input.to}: ${errorMessage(e)}`,
              },
            }
          }
        }
      }

      // Route to in-process subagent by name or raw agentId before falling
      // through to ambient-team resolution. Stopped agents are auto-resumed.
      if (typeof input.message === 'string' && input.to !== '*') {
        const appState = context.getAppState()
        const resolved = resolveSubagentRecipient(appState, input.to)
        if (resolved?.kind === 'ambiguous') {
          return { data: { success: false, message: `Recipient "${input.to}" is ambiguous. Re-send with a full name and ref:
${resolved.candidates.map(candidate => `  ${candidate.name} [${candidate.ref}]`).join('\n')}` } }
        }
        const agentId = resolved?.recipient.id
        const recipientName = resolved?.recipient.name ?? input.to
        if (agentId) {
          const teammate = findTeammateTaskByAgentId(agentId, appState.tasks)
          if (teammate?.status === 'running') {
            try {
              return await handleMessage(teammate.identity.agentName, input.message, input.summary, context, teammate.identity.teamName)
            } catch (error) {
              return {data:{success:false,message:`Teammate "${input.to}" is running, but writing to its inbox failed; nothing was queued. ${errorMessage(error)}`}}
            }
          }
          const rootWriter = context.setAppStateForTasks ?? context.setAppState
          let pending = pendingTeammateResumes.get(rootWriter)
          if (!pending) { pending = new Map(); pendingTeammateResumes.set(rootWriter, pending) }
          const previous = pending.get(agentId)
          if (previous) {
            const id = await previous
            const resumed = id ? context.getAppState().tasks[id] : undefined
            if (resumed?.type === 'in_process_teammate' && resumed.status === 'running') {
              return handleMessage(resumed.identity.agentName, input.message, input.summary, context, resumed.identity.teamName)
            }
          }
          const deferred = Promise.withResolvers<string | null>()
          pending.set(agentId, deferred.promise)
          let teammateResume = false
          try {
            // Like official, only an evicted agent's identity comes from disk; a
            // local agent still in state routes without reading its metadata.
            const metadata = isLocalAgentTask(context.getAppState().tasks[agentId]) ? null : await readAgentMetadata(asAgentId(agentId))
            if (metadata?.taskKind === 'in_process_teammate') {
              teammateResume = true
              const name = metadata.name ?? input.to
              const teamName = metadata.teamName ?? getTeamName(context.getAppState().teamContext)
              const running = Object.values(context.getAppState().tasks).find(task => task.type === 'in_process_teammate' && task.status === 'running' && (task.identity.resumableAgentId === agentId || (task.identity.agentName === name && task.identity.teamName === teamName)))
              if (running?.type === 'in_process_teammate') {
                deferred.resolve(running.id)
                return handleMessage(running.identity.agentName, input.message, input.summary, context, running.identity.teamName)
              }
              const result = await resumeInProcessTeammate({ resumableAgentId: agentId, prompt: input.message, senderName: getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME), meta: metadata, fallbackName: input.to, toolUseContext: context })
              deferred.resolve(result.taskId)
              return { data: { success: true, message: (result.resumedMessageCount > 0
                ? `Teammate "${input.to}" was not running; resumed it as an in-process teammate with ${result.resumedMessageCount} prior messages and your message as its next prompt.`
                : `Teammate "${input.to}" was not running; resumed it as an in-process teammate (no prior transcript) with your message as its next prompt.`) + (result.definitionNotice ? ` ${result.definitionNotice}` : '') } }
            }
          } catch (error) {
            return { data: { success: false, message: `Failed to resume ${teammateResume ? 'teammate' : 'agent'} "${input.to}": ${errorMessage(error)}` } }
          } finally {
            deferred.resolve(null)
            if (pending.get(agentId) === deferred.promise) pending.delete(agentId)
          }
          const task = context.getAppState().tasks[agentId]
          const shouldBind = !isMainSessionTask(task) && !(isLocalAgentTask(task) && task.status !== 'running' && task.stoppedByUser)
          const binding = shouldBind && resolved?.kind === 'one'
            ? bindSubagentRecipient(input.to, resolved.recipient, context.getAppState(), context.setAppStateForTasks ?? context.setAppState)
            : { kind: 'proceed' as const, pin: undefined }
          if (binding.kind === 'rebound') {
            logForDebugging(`[SendMessage] pin_rebound name=${recipientName} agent_id=${agentId}`, { level: 'warn' })
            return { data: { success: false, message: binding.message, display: binding.display } }
          }
          const pinReceipt = binding.pin ? { pin: binding.pin } : {}
          if (binding.pin) logForDebugging(`[SendMessage] pin_bound name=${binding.pin.name} agent_id=${binding.pin.id} ref=${binding.pin.ref}`)
          if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
            if (task.status === 'running') {
              queuePendingMessage(
                agentId,
                input.message,
                context.setAppStateForTasks ?? context.setAppState,
              )
              return {
                data: {
                  success: true,
                  message: `Message queued for delivery to ${recipientName} at its next tool round.`,
                  ...pinReceipt,
                },
              }
            }
            if (task.stoppedByUser) {
              logForDebugging(`[AgentCancellation] message_refused agent_id=${agentId} source=live`, { level: 'warn' })
              return { data: { success: false, message: cancelledAgentMessage(input.to) } }
            }
            // Completed, failed and system-interrupted tasks remain resumable.
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId,
                delivery: 'reply',
              })
              return {
                data: {
                  success: true,
                  ...pinReceipt,
                  ...(result.inlineHandback && { inlineHandback: { displayName: toAgentId(input.to) ? input.to.slice(0, 7) : input.to, ...result.inlineHandback } }),
                  message: result.inlineHandback ? RESUMED_AGENT_MESSAGE : `Agent "${input.to}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: e instanceof AgentStoppedByUserError ? e.message : `Agent "${input.to}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
                },
              }
            }
          } else {
            // task evicted from state — try resume from disk transcript.
            // agentId is either a registered name or a format-matching raw ID
            // (toAgentId validates the createAgentId format, so teammate names
            // never reach this block).
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId,
                delivery: 'reply',
              })
              return {
                data: {
                  success: true,
                  ...pinReceipt,
                  ...(result.inlineHandback && { inlineHandback: { displayName: toAgentId(input.to) ? input.to.slice(0, 7) : input.to, ...result.inlineHandback } }),
                  message: result.inlineHandback ? RESUMED_AGENT_MESSAGE : `Agent "${input.to}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: e instanceof AgentStoppedByUserError ? e.message : `Agent "${input.to}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
                },
              }
            }
          }
        }
      }

      if (input.to === '*') {
        if (typeof input.message !== 'string') {
          throw new Error('structured messages cannot be broadcast')
        }
        return handleBroadcast(input.message, input.summary, context)
      }

      const appState = context.getAppState()
      const teamName = getTeamName(appState.teamContext)
      const isTeamRecipient =
        teamName &&
        (Object.values(appState.teamContext?.teammates ?? {}).some(
          teammate => teammate.name === input.to,
        ) ||
          (await readTeamFileAsync(teamName))?.members.some(
            member => member.name === input.to,
          ))
      if (!isTeamRecipient) {
        if (feature('UDS_INBOX') && getUdsMessagingSocketPath()) {
          const { resolvePeerSession, sendToUdsSocket } =
            await import('../../utils/udsClient.js')
          try {
            const peer = await resolvePeerSession(input.to)
            if (peer) {
              if (typeof input.message !== 'string') {
                return {
                  data: {
                    success: false,
                    message:
                      'structured messages cannot be sent cross-session — only plain text',
                  },
                }
              }
              await sendToUdsSocket(peer.messagingSocketPath, input.message, {
                ...(context.modSpawnedBy ? {fromPlugin:context.modSpawnedBy} : {}),
                ...(context.abortController ? {signal:context.abortController.signal} : {}),
                fromMode:
                  appState.toolPermissionContext.mode === 'bypassPermissions' ||
                  (appState.toolPermissionContext.mode === 'plan' &&
                    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
                    ? 'bypass'
                    : 'prompting',
              })
              const preview = input.summary || truncate(input.message, 50)
              return {
                data: {
                  success: true,
                  message: `“${preview}” → ${peer.name} [${peer.ref}] (sent; acceptance and processing are not confirmed)`,
                },
              }
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send to ${input.to}: ${errorMessage(e)}`,
              },
            }
          }
        }
        return {
          data: {
            success: false,
            message: `Unknown recipient "${input.to}". Use ListAgents to discover local sessions, or use a known agent or teammate name.`,
          },
        }
      }

      if (typeof input.message === 'string') {
        return handleMessage(input.to, input.message, input.summary, context)
      }

      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan needs revision',
            context,
          )
      }
      }
      if (typeof input.message !== 'string') return send(input)
      const owned = context.modsSnapshot ? undefined : context.mods?.capture()
      const snapshot = context.modsSnapshot ?? owned
      const signal = context.abortController?.signal ?? new AbortController().signal
      let receipt: {data:SendMessageToolOutput} | undefined
      try {
        const result = await runModSessionSend(snapshot, {
          to:input.to,text:input.message,
          origin:context.modSpawnedBy ? {kind:'plugin',name:context.modSpawnedBy} : {kind:'model'},
          ...(context.agentId ? {agentId:context.agentId} : {}),
        }, async (value, branch) => {
          branch?.throwIfAborted()
          let rewritten: z.infer<InputSchema> = {...input,to:value.to,message:value.text}
          if (value.text !== input.message) delete rewritten.summary
          if (value.to !== input.to || value.text !== input.message) {
            const parsed = SendMessageTool.inputSchema.safeParse(rewritten)
            const validation = parsed.success ? await SendMessageTool.validateInput!(parsed.data,context) : undefined
            if (!parsed.success || validation?.result === false) {
              receipt = {data:{success:false,message:`A plugin hook rewrote this send into one the tool refuses (${validation?.result === false ? validation.message : 'a shape SendMessage does not accept'}); nothing was sent.`}}
              return sessionSendToolResult({result:receipt.data})
            }
            rewritten = parsed.data
          }
          if (value.to !== input.to) {
            if (typeof canUseTool !== 'function') {
              receipt = {data:{success:false,message:`A plugin hook readdressed this send to '${value.to}' and no permission check can run here; nothing was sent.`}}
              return sessionSendToolResult({result:receipt.data})
            }
            const approval = await canUseTool(SendMessageTool,rewritten,context,assistantMessage ?? createAssistantMessage({content:[]}),randomUUID())
            branch?.throwIfAborted()
            if (approval.behavior !== 'allow') {
              receipt = {data:{success:false,message:approval.behavior === 'deny' && approval.message ? approval.message : `Sending to '${value.to}' (a plugin hook readdressed this send) was not approved; nothing was sent.`}}
              return sessionSendToolResult({result:receipt.data})
            }
            if (approval.updatedInput !== undefined) {
              const narrowed = SendMessageTool.inputSchema.safeParse(approval.updatedInput)
              if (!narrowed.success) {
                receipt = {data:{success:false,message:'The permission handler narrowed the input to a shape SendMessage does not accept — nothing was sent.'}}
                return sessionSendToolResult({result:receipt.data})
              }
              rewritten = narrowed.data
            }
          }
          receipt = await send(rewritten)
          branch?.throwIfAborted()
          return sessionSendToolResult({result:receipt.data})
        }, signal)
        if (receipt && isEqual(sessionSendToolResult({result:receipt.data}),result)) return receipt
        return {data:{success:result.isDelivered,message:result.isDelivered ? 'Message delivered' : `Not sent: a plugin hook refused it (${result.reason}).`}}
      } finally {owned?.release()}
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)

// buildTool spreads the definition; keep the schema aligned with Teams opt-in.
Object.defineProperty(SendMessageTool, 'inputSchema', {
  get: () => isAgentSwarmsEnabled() ? inputSchema() : peerInputSchema(),
})
