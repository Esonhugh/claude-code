import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { buildTool, getEmptyToolPermissionContext } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from '../mods/runtime.js'
import { runToolUse } from './toolExecution.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
  setCachedSettingsForSource(source, {})
afterAll(() => {
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

// Shutdown aborts a running agent, which kills its shell. The shell still
// reports `Exit code 137` plus partial output, and official records that as
// the tool result instead of a synthetic "The operation was aborted" error.
test.each(['none', 'passthrough', 'failing after next'])('a tool result produced after the turn was aborted is recorded as is (tool.call hook: %s)', async hooked => {
  const inputSchema = z.object({ command: z.string() })
  const tool: Tool<typeof inputSchema, string> = buildTool({
    name: 'KilledShell',
    inputSchema,
    outputSchema: z.string(),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    description: async () => 'fixture',
    prompt: async () => 'fixture',
    renderToolUseMessage: () => null,
    call: async (_input, context) => {
      await new Promise<void>(resolve =>
        context.abortController.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return { data: 'Exit code 137\nHOLD_START' }
    },
    mapToolResultToToolResultBlockParam: (data: string, id: string) => ({
      type: 'tool_result', tool_use_id: id, content: data, is_error: true,
    }),
  })
  const runtime = createModsRuntime()
  const root = await mkdtemp(join(tmpdir(), 'aborted-result-'))
  if (hooked !== 'none') {
    const entry = join(root, 'register.ts')
    // A Mod that keeps working after the call fails once the turn is aborted.
    const after = hooked === 'passthrough' ? '' : `if (next.signal.aborted) throw new Error('mod failed after cancellation');`
    await writeFile(entry, `export function register(on) { on('tool.call', async ($, e, next) => { const r = await next(e); ${after} return r }) }`)
    await runtime.reconcile([{ name: 'passthrough', storageId: 'passthrough@inline', pluginRoot: root, entrypoints: [entry] }])
    expect(runtime.hasHooks('tool.call')).toBe(true)
  }
  const abortController = new AbortController()
  const context = {
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    abortController,
    messages: [],
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    mods: runtime,
  } as unknown as ToolUseContext
  const block = {
    type: 'tool_use' as const, caller: { type: 'direct' as const },
    id: 'toolu_killed', name: tool.name, input: { command: 'sleep 300' },
  }
  try {
    setTimeout(() => abortController.abort(), 50)
    const updates = await Array.fromAsync(runToolUse(
      block, createAssistantMessage({ content: [block] }), async () => ({ behavior: 'allow' }), context,
    ))
    const results = updates.flatMap(update => {
      const message = update.message
      return message.type === 'user' && Array.isArray(message.message.content)
        ? message.message.content.filter(part => part.type === 'tool_result')
        : []
    })
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_killed', content: 'Exit code 137\nHOLD_START', is_error: true },
    ])
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
