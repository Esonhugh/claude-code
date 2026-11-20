import { machine, release, type } from 'node:os'
import { context, propagation } from '@opentelemetry/api'
import { getMainThreadAgentType, getProjectConfigRoot, getPromptId, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { env } from '../../utils/env.js'
import { getScratchpadDir, isScratchpadEnabled } from '../../utils/permissions/filesystem.js'
import { getPluginDataDir } from '../../utils/plugins/pluginDirectories.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import type { ModBinding } from './runtime.js'
import stripAnsi from 'strip-ansi'
import type { SDKUINotifyMessage } from '../../entrypoints/sdk/coreTypes.generated.js'

export function modSessionInfo() {
  const promptId = getPromptId(), agentType = getMainThreadAgentType(), configRoot = getProjectConfigRoot()
  return {
    transcriptPath: isSessionPersistenceDisabled() ? '' : getTranscriptPath(),
    ...(isScratchpadEnabled() ? { scratchpadDir: getScratchpadDir() } : {}),
    ...(promptId == null ? {} : { promptId }), ...(agentType === undefined ? {} : { agentType }),
    ...(configRoot == null ? {} : { configRoot }),
    platform: env.isWslEnvironment() ? 'wsl' : ({ darwin: 'macos', win32: 'windows', linux: 'linux' } as Record<string,string>)[process.platform] ?? 'unknown',
    isHosted: false, // The local CLI engine (including remote-control sessions), not the hosted server.
  }
}

export async function modSessionMachine() {
  const [packageManagers, runtimes] = await Promise.all([env.getPackageManagers(), env.getRuntimes()])
  return { sysname: type(), release: release(), machine: machine(), packageManagers: [...packageManagers], runtimes: [...runtimes] }
}

export function modProcessHookEnv(binding: ModBinding, projectRoot: string, pluginRoot: string, storageId: string) {
  const trace: Record<string,string> = {}
  propagation.inject(context.active(), trace)
  return {
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: binding.sessionId, CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ATTENDED: binding.isInteractive ? '1' : '0', CLAUDE_PID: String(process.pid),
    CLAUDE_PROJECT_DIR: getProjectConfigRoot() ?? projectRoot,
    CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: getPluginDataDir(storageId),
    ...(trace.traceparent ? {TRACEPARENT:trace.traceparent} : {}),
  }
}

export function validateNotifyKey(key: unknown) {
  if (typeof key !== 'string' || !key || key.length > 64 || key in Object.prototype ||
      key !== key.trim().replace(/\s+/gu, ' ') || /[\p{Cc}\p{Default_Ignorable_Code_Point}]/u.test(key))
    throw new TypeError('key must be 1 to 64 characters without hidden characters, stray spaces or object prototype names')
}

export function validateNotifySchedule(input: Record<string, unknown>) {
  if (input.key !== undefined) validateNotifyKey(input.key)
  const { delayMs, at, untilBack } = input
  const week = 7 * 24 * 60 * 60 * 1000
  if ((delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > week)) ||
      (at !== undefined && (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > Date.now() + week)) ||
      (delayMs !== undefined && at !== undefined)) throw new TypeError('give delayMs or at, not both, as whole milliseconds up to 7 days ahead')
  if (untilBack !== undefined && typeof untilBack !== 'boolean') throw new TypeError('untilBack is a boolean, when given')
}

export function modNotifyFrame(input: Record<string, unknown>, plugin: string, source: string, rewritten: boolean): Omit<SDKUINotifyMessage,'uuid'|'session_id'> {
  const clean = (text: string) => stripAnsi(text).replace(/[\p{Cc}\p{Cf}\uFFFC]/gu, c => c === '\n' ? c : '')
  const title = clean(String(input.title ?? '').replace(/\s+/gu,' ')).trim() || clean(plugin).trim()
  return {
    type: 'system', subtype: 'ui_notify', plugin, source, rewritten,
    title: [...title].slice(0,120).join(''), text: [...clean(String(input.text).replace(/\r\n?|[\u2028\u2029]/gu,'\n').replaceAll('\t',' '))].slice(0,1000).join(''),
    ...(typeof input.key === 'string' ? {key:input.key} : {}), ...(typeof input.at === 'number' ? {at:input.at} : {}),
    ...(typeof input.delayMs === 'number' ? {delay_ms:input.delayMs} : {}), ...(typeof input.untilBack === 'boolean' ? {until_back:input.untilBack} : {}),
  }
}
