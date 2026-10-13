import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { isAgentOffered } from '../../services/mods/agentOffer.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import { getGlobalConfig } from '../config.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { findCanonicalGitRoot } from '../git.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../messages.js'
import { normalizePathForConfigKey } from '../path.js'
import { filterDeniedAgents } from '../permissions/permissions.js'
import {
  type AgentMetadata,
  getAgentTranscript,
} from '../sessionStorage.js'
import { isSourceAdminTrusted } from '../settings/pluginOnlyPolicy.js'
import { getTeamName } from '../teammate.js'
import {
  dropMailboxMessagesByPredicate,
  isStructuredProtocolMessage,
} from '../teammateMailbox.js'
import { reconstructForSubagentResume } from '../toolResultStorage.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { startInProcessTeammate } from './inProcessRunner.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import { mutateTeamFileAsync } from './teamHelpers.js'

export type ResumeInProcessTeammateResult = {
  agentId: string
  taskId: string
  resumedMessageCount: number
  definitionNotice?: string
}

function cleanStoredText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  let text = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  // eslint-disable-next-line no-control-regex -- Preserve the native metadata ANSI sanitizer.
  const ansi = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/g
  for (let i = 0; i < 4; i++) {
    const cleaned = text.replace(ansi, '')
    if (cleaned === text) break
    text = cleaned
  }
  text = text.replace(/(?:(?![\u200c\u200d])[\p{Cc}\p{Cf}]|[\u2028\u2029])+/gu, ' ').replace(/ {2,}/g, ' ').trim()
  if (!text) return undefined
  if (text.length <= 1024) return text
  const end = text.charCodeAt(1023)
  return `${text.slice(0, end >= 0xd800 && end <= 0xdbff ? 1023 : 1024)}…`
}

function canRestoreDefinition(agent: AgentDefinition): boolean {
  if (isSourceAdminTrusted(agent.source) || agent.source === 'userSettings' || agent.source === 'flagSettings') return true
  let origin = agent.baseDir ?? getCwd()
  if (basename(origin) === 'agents' && basename(dirname(origin)) === '.claude') origin = dirname(dirname(origin))
  let path = resolve(origin)
  try { path = realpathSync(path) } catch { /* Keep the resolved path when realpath is unavailable. */ }
  const key = normalizePathForConfigKey(findCanonicalGitRoot(path) ?? path)
  return getGlobalConfig().projects?.[key]?.hasTrustDialogAccepted === true
}

export async function resumeInProcessTeammate({
  resumableAgentId,
  prompt,
  senderName,
  meta,
  fallbackName,
  toolUseContext,
}: {
  resumableAgentId: string
  prompt: string
  senderName: string
  meta: AgentMetadata
  fallbackName: string
  toolUseContext: ToolUseContext
}): Promise<ResumeInProcessTeammateResult> {
  const name = meta.name ?? fallbackName
  const teamName = meta.teamName ?? getTeamName(toolUseContext.getAppState().teamContext)
  if (!name || !teamName) throw Error('Cannot resume teammate: no team is active in this session')
  const lower = typeof name === 'string' ? name.toLowerCase() : ''
  if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(name) || ['main', 'team-lead', 'user', 'system'].includes(lower) || toAgentId(lower) !== null) {
    throw Error('Cannot resume teammate: its recorded name is reserved, looks like an agent id, or is not a valid name')
  }
  const description = cleanStoredText(meta.description)
  // Local transcript reads intentionally return null on load failure. Only errors
  // actually thrown by the loader (including a future hydration path) reach here.
  const transcript = await getAgentTranscript(asAgentId(resumableAgentId)).catch(error => {
    if (toolUseContext.abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
    throw Error(`Cannot resume teammate: its transcript could not be loaded (${errorMessage(error)})`, { cause: error })
  })
  toolUseContext.abortController.signal.throwIfAborted()
  let messages = transcript?.messages ?? []
  if (transcript) {
    messages = filterUnresolvedToolUses(messages)
    let previousLength: number
    do {
      previousLength = messages.length
      messages = filterWhitespaceOnlyAssistantMessages(filterOrphanedThinkingOnlyMessages(messages), { mergeAdjacentUsers: false })
    } while (messages.length !== previousLength)
  }
  const replacementState = reconstructForSubagentResume(toolUseContext.contentReplacementState, messages, transcript?.contentReplacements ?? [])
  let agentDefinition: AgentDefinition | undefined
  let definitionNotice: string | undefined
  if (meta.customAgentType) {
    const candidate = toolUseContext.options.agentDefinitions.activeAgents.find(agent => agent.agentType === meta.customAgentType && !isBuiltInAgent(agent))
    const allowedTypes = toolUseContext.options.agentDefinitions.allowedAgentTypes
    const withheld = candidate !== undefined && (
      (allowedTypes !== undefined && !allowedTypes.includes(candidate.agentType)) ||
      filterDeniedAgents([candidate], toolUseContext.getAppState().toolPermissionContext, AGENT_TOOL_NAME).length === 0 ||
      !(await isAgentOffered(candidate, { snapshot: toolUseContext.modsSnapshot, signal: toolUseContext.abortController.signal }))
    )
    if (withheld) {
      definitionNotice = 'Its agent definition was not restored: that agent type can no longer be spawned in this session (a permission rule, this agent\'s own allowed agent types or a plugin excludes it), so the teammate is running with the team-essential tools and no custom instructions.'
      logForDebugging(`[resumeInProcessTeammate] Definition ${meta.customAgentType} withheld by allowed agent types, permission rules, or agent.offer`)
    } else if (candidate && canRestoreDefinition(candidate)) {
      agentDefinition = candidate
    } else if (candidate) {
      definitionNotice = 'Its agent definition was not restored: the folder its definition file came from is not trusted, so the teammate is running with the team-essential tools and no custom instructions. The user must accept the trust dialog in that folder to restore it.'
      logForDebugging(`[resumeInProcessTeammate] Definition ${meta.customAgentType} source=${candidate.source} folder=${candidate.baseDir ?? getCwd()} is untrusted`)
    } else {
      logForDebugging(`[resumeInProcessTeammate] Definition ${meta.customAgentType} is no longer present`)
    }
    agentDefinition ??= { agentType: meta.customAgentType, whenToUse: '', tools: [], getSystemPrompt: () => '', source: 'projectSettings' }
  }
  if (!(await dropMailboxMessagesByPredicate(name, message => isStructuredProtocolMessage(message.text), teamName))) {
    logForDebugging(`[resumeInProcessTeammate] Stale protocol-frame drop for ${name} did not land; resumed runner may see stale protocol frames`)
  }
  const context = { ...toolUseContext, setAppState: toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState }
  const spawned = await spawnInProcessTeammate({
    name, teamName, prompt, description,
    agentType: cleanStoredText(agentDefinition?.agentType), parentAgentId: cleanStoredText(meta.parentAgentId),
    color: meta.color, planModeRequired: meta.planModeRequired ?? false, model: meta.model,
    permissionMode: meta.permissionMode !== undefined && meta.permissionMode !== 'bypassPermissions' && ['acceptEdits', 'auto', 'default', 'dontAsk', 'plan'].includes(meta.permissionMode) ? meta.permissionMode : undefined,
    resumableAgentId,
  }, context)
  if (!spawned.success || !spawned.identity || !spawned.taskId || !spawned.teammateContext || !spawned.abortController) throw Error('Failed to respawn in-process teammate')
  const now = Date.now()
  await mutateTeamFileAsync(teamName, {
    mutation: 'resumeInProcessTeammate', agentId: spawned.agentId,
    mutate: team => {
      const member = team.members.find(member => member.agentId === spawned.agentId)
      if (member) member.joinedAt = now
      else team.members.push({ agentId: spawned.agentId, name, color: meta.color, agentType: meta.customAgentType, planModeRequired: meta.planModeRequired, joinedAt: now, tmuxPaneId: 'in-process', cwd: getCwd(), subscriptions: [], backendType: 'in-process' })
      return { result: undefined, changed: true }
    },
  }).catch(error => logForDebugging(`[resumeInProcessTeammate] Team file re-add failed (ad-hoc team?): ${errorMessage(error)}`))
  context.setAppState(state => ({ ...state, teamContext: {
    ...state.teamContext, teamName: state.teamContext?.teamName ?? teamName,
    teamFilePath: state.teamContext?.teamFilePath ?? '', leadAgentId: state.teamContext?.leadAgentId ?? TEAM_LEAD_NAME,
    teammates: { ...state.teamContext?.teammates, [spawned.agentId]: { name, color: meta.color, agentType: meta.customAgentType, tmuxSessionName: 'in-process', tmuxPaneId: 'in-process', cwd: getCwd(), spawnedAt: now } },
  } }))
  startInProcessTeammate({
    identity: spawned.identity, taskId: spawned.taskId, prompt, initialFrom: senderName, description, agentDefinition,
    model: meta.model, teammateContext: spawned.teammateContext, toolUseContext: { ...context, messages: [] },
    effort: meta.effort,
    abortController: spawned.abortController, resumeMessages: messages, resumeReplacementState: replacementState,
  })
  logForDebugging(`[resumeInProcessTeammate] Resumed ${spawned.agentId} logicalId=${resumableAgentId} with ${messages.length} prior messages`)
  return { agentId: spawned.agentId, taskId: spawned.taskId, resumedMessageCount: messages.length, definitionNotice }
}
