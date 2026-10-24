import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import type { AppState } from '../../state/AppState.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getRegisteredSessionName } from '../../utils/concurrentSessions.js'
import { formatDuration } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { peerRef } from '../../utils/peerProtocol.js'
import {
  listAllLiveSessions,
  type LiveSessionInfo,
} from '../../utils/udsClient.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'
import { renderToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>
type Output = { listing: string; agents: LiveSessionInfo[] }

type Subagent = { id: string; name?: string; agentType: string; status: string; startTime: number }
type Teammate = { name: string; agentType?: string; status?: string; since: number }

const ROW_LIMIT = 100
const ago = (ms: number) => `${formatDuration(Math.max(0, ms), { mostSignificantOnly: true })} ago`
const row = (fields: (string | undefined)[]) => `  ${fields.filter(Boolean).join('  ·  ')}`

function section(title: string, rows: string[]): string {
  const shown = rows.slice(0, ROW_LIMIT)
  if (rows.length > shown.length) shown.push(`  (… ${rows.length - shown.length} more not shown)`)
  return `${title} (${rows.length}):\n${shown.join('\n')}`
}

export function listSubagents(state: Pick<AppState, 'tasks' | 'agentNameRegistry'>): Subagent[] {
  const names = new Map([...state.agentNameRegistry].map(([name, id]) => [id as string, name]))
  return Object.values(state.tasks).flatMap(task =>
    task.type === 'local_agent' && task.agentType !== 'main-session'
      ? [{ id: task.id, name: names.get(task.id), agentType: task.agentType, status: task.status, startTime: task.startTime }]
      : [],
  )
}

export function listTeammates(state: Pick<AppState, 'tasks' | 'teamContext'>): Teammate[] {
  const team = state.teamContext
  if (!team) return []
  const self = team.selfAgentId ?? (team.isLeader === false ? undefined : team.leadAgentId)
  const status = new Map(Object.values(state.tasks).flatMap(task =>
    task.type === 'in_process_teammate' ? [[task.identity.agentId, task.isIdle ? 'idle' : task.status] as const] : []))
  return Object.entries(team.teammates).flatMap(([id, teammate]) => id === self ? [] : [{
    name: teammate.name,
    agentType: teammate.agentType,
    status: status.get(id),
    since: teammate.spawnedAt,
  }])
}

/** Official-style text listing: this session's own address, then subagents, teammates and peer sessions. */
export function formatAgentListing(
  self: { name: string; ref: string } | undefined,
  subagents: Subagent[],
  teammates: Teammate[],
  peers: LiveSessionInfo[],
  now = Date.now(),
): string {
  const sections: string[] = []
  if (subagents.length) {
    sections.push(section('Subagents', subagents.map(agent => row([agent.name ? `${agent.name} [${agent.id}]` : agent.id, agent.agentType, agent.status, `started ${ago(now - agent.startTime)}`]))))
  }
  if (teammates.length) {
    sections.push(section('Teammates', teammates.map(teammate => row([teammate.name, teammate.agentType, teammate.status, `started ${ago(now - teammate.since)}`]))))
  }
  if (peers.length) {
    sections.push(section('Peer sessions', peers.map(peer => row([`${peer.name} [${peer.ref}]`, peer.kind, peer.status, `started ${ago(now - peer.startedAt)}`]))))
  }
  const intro = self
    ? `This session is ${self.name} [${self.ref}] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).`
    : undefined
  if (!sections.length) {
    return intro
      ? `${intro}\nNo reachable agents — no other Claude session is running on this machine right now (peer messaging itself is available; a session appears here once it is started).`
      : 'No reachable agents.'
  }
  return [intro, ...sections].filter(Boolean).join('\n\n')
}

export const ListAgentsTool = buildTool({
  name: 'ListAgents',
  searchHint: 'discover local Claude sessions for SendMessage',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return feature('UDS_INBOX') ? getUdsMessagingSocketPath() !== null : false
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return 'List other live local Claude sessions'
  },
  async prompt() {
    return 'Discover other live Claude sessions on this machine. Use SendMessage with a listed name, "name [ref]", or sessionId to send plain text. Each row shows whether that session is busy or idle right now. Discovery does not guarantee that a message will be accepted or processed. To hear when a session finishes, use SendMessage with notify_when_idle instead of listing again in a loop.'
  },
  async call(_input, context) {
    const agents = await listAllLiveSessions()
    const state = context.getAppState()
    const socket = getUdsMessagingSocketPath()
    const name = getRegisteredSessionName()
    return {
      data: {
        listing: formatAgentListing(socket && name ? { name, ref: peerRef(socket).slice(0, 6) } : undefined, listSubagents(state), listTeammates(state), agents),
        agents,
      },
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage,
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: data.listing,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
