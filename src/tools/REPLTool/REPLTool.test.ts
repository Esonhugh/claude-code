import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  clearRegisteredHooks,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { buildTool, getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { getReplPrompt } from './prompt.js'
import { REPL_NEW_CONTEXT_NOTICE, REPL_TIMEOUT_RESET_NOTE, REPLTool, replTotalCapFor } from './REPLTool.js'
import { releaseAllReplSessions } from './sessions.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
  setCachedSettingsForSource(source, {})
afterAll(() => {
  releaseAllReplSessions()
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

const registered = getRegisteredHooks()
const interactive = getIsInteractive()
beforeEach(() => {
  clearRegisteredHooks()
  setIsInteractive(false)
})
afterEach(() => {
  clearRegisteredHooks()
  if (registered) registerHookCallbacks(registered)
  setIsInteractive(interactive)
})

const allow: CanUseToolFn = async () => ({ behavior: 'allow' })

function fakeTool(name: string, inputSchema: z.ZodObject, call: (input: Record<string, unknown>) => unknown) {
  return buildTool({
    name,
    inputSchema,
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    description: async () => `${name} fake`,
    prompt: async () => `${name} fake prompt`,
    renderToolUseMessage: () => null,
    call: async (input: Record<string, unknown>) => ({ data: call(input) }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: JSON.stringify(data),
    }),
  } as Parameters<typeof buildTool>[0]) as Tool
}

const fakeRead = fakeTool('Read', z.object({ file_path: z.string() }), input => ({
  type: 'text',
  file: { filePath: input.file_path, content: `contents of ${String(input.file_path)}` },
}))
const fakeBash = fakeTool('Bash', z.object({ command: z.string() }), input => ({
  stdout: `ran ${String(input.command)}`,
  stderr: '',
  interrupted: false,
}))

let nextAgent = 0
function contextFor(o: { mode?: PermissionMode; messages?: unknown[]; agentId?: string } = {}) {
  const permissions = { ...getEmptyToolPermissionContext(), mode: o.mode ?? 'default' }
  return {
    options: { tools: [REPLTool, fakeRead, fakeBash], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: o.messages ?? [],
    agentId: o.agentId ?? `agent-${nextAgent++}`,
    toolUseId: 'toolu_current',
    getAppState: () => ({ toolPermissionContext: permissions, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
}

async function run(code: string, context: ToolUseContext, o: { timeout?: number; canUseTool?: CanUseToolFn } = {}) {
  const result = await REPLTool.call(
    { code, ...(o.timeout === undefined ? {} : { timeout: o.timeout }) },
    context,
    o.canUseTool ?? allow,
    undefined as never,
    undefined,
  )
  const block = REPLTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_current')
  return { ...result, text: block.content as string }
}

describe('REPL end to end through the executor', () => {
  test('a script calls Read and Bash and returns their values', async () => {
    const { text, data, newMessages } = await run(
      'const r = await Read({file_path: "a.txt"}); const b = await Bash({command: "ls"}); self.log(b.stdout); r.file.content',
      contextFor(),
    )
    expect(text).toBe("<repl-output>\n<log>ran ls</log>\n<result>contents of a.txt</result>\n</repl-output>")
    expect(data).toMatchObject({ result: 'contents of a.txt', stdout: 'ran ls', stderr: '' })
    // Two virtual pairs: assistant tool_use and user tool_result per inner call.
    const messages = (newMessages ?? []) as { type: string; isVirtual?: boolean }[]
    expect(messages.map(m => [m.type, m.isVirtual])).toEqual([
      ['assistant', true],
      ['user', true],
      ['assistant', true],
      ['user', true],
    ])
    const [use] = (messages[0] as unknown as { message: { content: { id: string; name: string }[] } }).message.content
    expect(use!.name).toBe('Read')
    expect(use!.id).toMatch(/^repl_/)
  })

  test('variables persist between calls of one thread', async () => {
    const context = contextFor()
    await run('const kept = 41', context)
    expect((await run('kept + 1', context)).text).toContain('<result>42</result>')
  })

  test('a context lost to a timeout says so on the next result', async () => {
    const context = contextFor()
    await run('var before = 1', context)
    const stopped = await run('while (true) {}', context, { timeout: 200 })
    expect(stopped.data.timedOut).toBe(true)
    const next = await run('typeof before', context)
    expect(next.text.startsWith(`${REPL_NEW_CONTEXT_NOTICE}\n${REPL_TIMEOUT_RESET_NOTE}\n<repl-output>`)).toBe(true)
    expect(next.text).toContain('<result>undefined</result>')
  })

  test('a new context in a conversation with earlier scripts says so once', async () => {
    const earlier = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_old', name: 'REPL', input: {} }] } }
    const context = contextFor({ messages: [earlier] })
    expect((await run('1', context)).text.startsWith(REPL_NEW_CONTEXT_NOTICE)).toBe(true)
    expect((await run('2', context)).text.startsWith('<repl-output>')).toBe(true)
    expect((await run('1', contextFor())).text.startsWith('<repl-output>')).toBe(true)
  })

  test('a denied call inside a script resolves {error} and the script goes on', async () => {
    const deny: CanUseToolFn = async () => ({ behavior: 'deny', message: 'no', decisionReason: { type: 'other', reason: 'test' } })
    const { text } = await run('const r = await Bash({command: "rm -rf /"}); [r.error, "after"]', contextFor(), { canUseTool: deny })
    expect(text).toContain('Permission denied for Bash: no')
    expect(text).toContain('after')
  })

  test('describeTool and searchTools see the callable tools', async () => {
    const { text } = await run(
      'const d = await describeTool("Bash"); const s = await searchTools("bash"); JSON.stringify([d.description, d.inputSchema.type, s[0].name, s[0].input, await searchTools("")])',
      contextFor(),
    )
    expect(text).toContain('Bash fake prompt')
    expect(text).toContain('{\\n  command: string;\\n}')
    expect(text).toContain('searchTools needs a query')
  })
})

describe('REPL tool definition', () => {
  test('name, alias, display name and schema', () => {
    expect(REPLTool.name).toBe('REPL')
    expect(REPLTool.aliases).toEqual(['Eval'])
    expect(REPLTool.userFacingName(undefined)).toBe('Code')
    expect(REPLTool.maxResultSizeChars).toBe(100_000)
    expect(REPLTool.isConcurrencySafe({ code: '' })).toBe(false)
    expect(REPLTool.inputSchema.safeParse({ code: 'x', extra: 1 }).success).toBe(false)
    expect(REPLTool.toAutoClassifierInput({ code: 'await $`ls`' })).toBe('await $`ls`')
  })

  test('auto mode hands the script to the classifier; other modes allow it', async () => {
    const input = { code: '1' }
    expect(await REPLTool.checkPermissions(input, contextFor({ mode: 'auto' }))).toEqual({
      behavior: 'passthrough',
      message: 'Code Mode script requires classifier review.',
    })
    expect(await REPLTool.checkPermissions(input, contextFor())).toEqual({ behavior: 'allow', updatedInput: input })
  })

  test('the whole-script cap applies only in modes that can ask', () => {
    expect(replTotalCapFor('default')).toBe(600_000)
    expect(replTotalCapFor('acceptEdits')).toBe(600_000)
    expect(replTotalCapFor('auto')).toBeUndefined()
    expect(replTotalCapFor('bypassPermissions')).toBeUndefined()
  })

  test('description and summary', async () => {
    expect(await REPLTool.description({ code: 'x', description: 'Find  the\nflag' })).toBe(
      'Find the flag (first line of several)',
    )
    expect(await REPLTool.description({ code: 'x' })).toBe('Run commands')
    expect(REPLTool.getToolUseSummary?.({ code: '\nconst a = 1\nmore' })).toBe('const a = 1')
  })

  test('the prompt carries the official key lines and the helper declarations', () => {
    const prompt = getReplPrompt([REPLTool, fakeRead, fakeBash], getEmptyToolPermissionContext())
    expect(prompt).toContain('The REPL is one persistent JavaScript context')
    expect(prompt).toContain("A call's result is a `<repl-output>` element")
    expect(prompt).toContain('## Declarations')
    expect(prompt).toContain('declare function $(strings: TemplateStringsArray')
    expect(prompt).toContain('declare function describeTool(name: string)')
    expect(prompt).not.toContain('dispatched #')
  })
})
