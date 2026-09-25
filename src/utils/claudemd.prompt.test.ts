import { describe, expect, mock, spyOn, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('CLAUDE.md prompt boundary', () => {
  test('scopes project instructions below mode and runtime enforcement', () => {
    const source = readFileSync(
      new URL('./claudemd.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('override default task behavior')
    expect(source).toContain('do not override active permission modes')
    expect(source).toContain('runtime safety enforcement')
    expect(source).not.toContain('OVERRIDE any default behavior')
  })
})

const childFlag = 'CLAUDE_CODE_INSTRUCTION_DISCOVERY_TEST_CHILD'

if (!process.env[childFlag]) {
  test('discovers AGENTS.md alongside CLAUDE.md using isolated settings', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'instruction-discovery-')),
    )
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          DISABLE_AUTOUPDATER: '1',
          [childFlag]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  const root = process.env.HOME!
  // Keep the managed policy boundary inside the fixture as well.
  mock.module('./settings/managedPath.js', () => ({
    getManagedFilePath: () => join(root, 'managed'),
    getManagedSettingsDropInDir: () =>
      join(root, 'managed', 'managed-settings.d'),
  }))

  test('loads both project filenames from parents to cwd in stable order', async () => {
    const parent = join(root, 'workspace')
    const project = join(parent, 'project')
    mkdirSync(project, { recursive: true })
    for (const [dir, label] of [
      [parent, 'parent'],
      [project, 'project'],
    ]) {
      writeFileSync(join(dir!, 'AGENTS.md'), `${label} agents instructions`)
      writeFileSync(join(dir!, 'CLAUDE.md'), `${label} claude instructions`)
    }
    const { setOriginalCwd, setAllowedSettingSources } =
      await import('../bootstrap/state.js')
    setOriginalCwd(project)
    setAllowedSettingSources(['projectSettings', 'localSettings'])
    const { getMemoryFiles, getClaudeMds } = await import('./claudemd.js')
    const files = await getMemoryFiles()
    expect(files.map(file => file.path)).toEqual([
      join(parent, 'AGENTS.md'),
      join(parent, 'CLAUDE.md'),
      join(project, 'AGENTS.md'),
      join(project, 'CLAUDE.md'),
    ])
    expect(files.every(file => file.type === 'Project')).toBe(true)
    const prompt = getClaudeMds(files)
    expect(prompt).toContain('parent agents instructions')
    expect(prompt).toContain('project claude instructions')
  })

  test('injects AGENTS.md into user context and honors the instruction disable switch', async () => {
    const project = join(root, 'context-project')
    mkdirSync(project)
    writeFileSync(join(project, 'AGENTS.md'), 'shared context instructions')
    writeFileSync(join(project, 'CLAUDE.md'), 'Claude context instructions')
    const { getCachedClaudeMdContent, setOriginalCwd } =
      await import('../bootstrap/state.js')
    const { clearMemoryFileCaches } = await import('./claudemd.js')
    const { getUserContext, getUserContextInstructionFiles } = await import('../context.js')
    setOriginalCwd(project)
    clearMemoryFileCaches()
    getUserContext.cache.clear?.()
    const context = await getUserContext()
    expect(context.claudeMd).toContain('shared context instructions')
    expect(context.claudeMd).toContain('Claude context instructions')
    expect(getCachedClaudeMdContent()).toBe(context.claudeMd)
    expect(getUserContextInstructionFiles(context)).toEqual([
      { path: join(project, 'AGENTS.md'), kind: 'project', content: 'shared context instructions' },
      { path: join(project, 'CLAUDE.md'), kind: 'project', content: 'Claude context instructions' },
    ])
    expect(getUserContextInstructionFiles({ claudeMd: context.claudeMd! })).toBeUndefined()
    expect(getUserContextInstructionFiles({ currentDate: 'today' })).toEqual([])
    try {
      process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
      getUserContext.cache.clear?.()
      expect((await getUserContext()).claudeMd).toBeUndefined()
      expect(getCachedClaudeMdContent()).toBeNull()
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS
      getUserContext.cache.clear?.()
      clearMemoryFileCaches()
    }
  })

  test('tracks imported loaded content and core admission without rediscovering excluded files', async () => {
    const project = join(root, 'snapshot-project')
    mkdirSync(project)
    writeFileSync(join(project, 'AGENTS.md'), '@./import.md\n\nproject marker')
    writeFileSync(join(project, 'import.md'), '---\nlabel: fixture\n---\n<!-- hidden marker -->\nimport marker')
    writeFileSync(join(project, 'CLAUDE.md'), 'Claude marker')
    const { setOriginalCwd } = await import('../bootstrap/state.js')
    const { clearMemoryFileCaches, getMemoryFiles } = await import('./claudemd.js')
    const { getUserContext, getUserContextInstructionFiles } = await import('../context.js')
    const growthbook = await import('../services/analytics/growthbook.js')
    const featureValue = growthbook.getFeatureValue_CACHED_MAY_BE_STALE
    setOriginalCwd(project)
    clearMemoryFileCaches()
    getUserContext.cache.clear?.()
    try {
      const context = await getUserContext()
      const files = getUserContextInstructionFiles(context)!
      expect(files.map(file => file.path)).toEqual([
        join(project, 'AGENTS.md'), join(project, 'import.md'), join(project, 'CLAUDE.md'),
      ])
      expect(files[1]).toEqual({
        path: join(project, 'import.md'), kind: 'project', content: 'import marker', parent: join(project, 'AGENTS.md'),
      })
      expect(context.claudeMd).not.toContain('hidden marker')
      expect(context.claudeMd).not.toContain('label: fixture')
      // The snapshot must not leak the loader's mutable cached entries.
      files[1]!.content = 'mutated consumer'
      expect(getUserContextInstructionFiles(context)?.[1]?.content).toBe('import marker')
      expect((await getMemoryFiles())[1]?.content).toBe('import marker')
      const gate = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation((name, fallback) =>
        name === 'tengu_paper_halyard' ? true : featureValue(name, fallback) as any,
      )
      try {
        getUserContext.cache.clear?.()
        const withheld = await getUserContext()
        expect(withheld.claudeMd).toBeUndefined()
        expect(getUserContextInstructionFiles(withheld)).toEqual([])
      } finally { gate.mockRestore() }
    } finally {
      getUserContext.cache.clear?.()
      clearMemoryFileCaches()
    }
  })

  test('Worker instruction rewrites reach Anthropic messages and OpenAI input without network', async () => {
    const project = join(root, 'wire-project')
    mkdirSync(project)
    writeFileSync(join(project, 'AGENTS.md'), '@./import.md\n\nremoved project marker')
    writeFileSync(join(project, 'import.md'), 'removed import marker')
    writeFileSync(join(project, 'CLAUDE.md'), 'removed Claude marker')
    const entry = join(project, 'register.ts')
    writeFileSync(entry, `export function register(on) {
      on('prompt.context', ($, e, next) => {
        const scenario = e.blocks.find(b => b.name === 'scenario').text;
        if (scenario === 'unknown') return next({ ...e, blocks: e.blocks.map(b => b.name === 'claudeMd' ? {...b, text:'opaque replacement marker'} : b) });
        return next({ ...e, instructionFiles: scenario === 'empty' ? [] : [
          {...e.instructionFiles[2], content:'first replacement marker'},
          {...e.instructionFiles[1], content:'second imported replacement marker'},
        ] });
      });
      on('prompt.context', ($, e, next) => {
        const scenario = e.blocks.find(b => b.name === 'scenario').text;
        if (scenario === 'unknown' && e.instructionFiles !== undefined) throw new Error('opaque text retained false provenance');
        if (scenario === 'empty' && e.blocks.some(b => b.name === 'claudeMd')) throw new Error('deleted files retained text');
        if (scenario === 'replace' && !e.blocks.find(b => b.name === 'claudeMd').text.includes('second imported replacement marker')) throw new Error('next saw stale text');
        return next(e);
      });
    }`)
    const { setOriginalCwd } = await import('../bootstrap/state.js')
    const { clearMemoryFileCaches } = await import('./claudemd.js')
    const { getUserContext, getUserContextInstructionFiles, withUserContextInstructionFiles } = await import('../context.js')
    const { query } = await import('../query.js')
    const { createModsRuntime } = await import('../services/mods/runtime.js')
    const { getDefaultAppState } = await import('../state/AppStateStore.js')
    const { createFileStateCacheWithSizeLimit } = await import('./fileStateCache.js')
    const { createAssistantMessage, createUserMessage, normalizeMessagesForAPI } = await import('./messages.js')
    const { asSystemPrompt } = await import('./systemPromptType.js')
    const { getOpenAIAuthInfo } = await import('./auth.js')
    const { createOpenAICompatClient } = await import('../services/api/openai-compat.js')
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({ onDiagnostic: diagnostic => diagnostics.push(diagnostic) })
    const originalEnv = process.env.NODE_ENV
    const originalFetch = globalThis.fetch
    const { enableConfigs } = await import('./config.js')
    enableConfigs()
    process.env.NODE_ENV = 'production'
    setOriginalCwd(project)
    clearMemoryFileCaches()
    getUserContext.cache.clear?.()
    try {
      await runtime.reconcile([{ name: 'instructions-wire', storageId: 'instructions-wire@inline', pluginRoot: project, entrypoints: [entry] }])
      const base = await getUserContext()
      const sourceFiles = getUserContextInstructionFiles(base)!
      for (const provider of ['anthropic', 'openai'] as const) {
        for (const scenario of ['replace', 'empty', 'unknown'] as const) {
          const bodies: any[] = []
          const fetchMock = (async (_input: unknown, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)))
            return provider === 'anthropic'
              ? Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
              : new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          }) as typeof fetch
          globalThis.fetch = fetchMock
          getOpenAIAuthInfo.cache.set(undefined, { accessToken: 'fixture-not-a-credential', isChatGPT: false })
          const client = provider === 'anthropic'
            ? new Anthropic({ apiKey: 'fixture-not-a-credential', baseURL: 'https://fixture.invalid', fetch: fetchMock })
            : createOpenAICompatClient({ apiKey: 'fixture-not-a-credential', timeout: 1000, maxRetries: 0 })
          let state = getDefaultAppState()
          const toolUseContext = {
            options: { commands: [], debug: false, mainLoopModel: 'claude-test', tools: [], verbose: false,
              thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
              agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined } },
            abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
            getAppState: () => state, setAppState: (update: any) => { state = update(state) },
            setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
            messages: [], mods: runtime,
          } satisfies import('../Tool.js').ToolUseContext
          const userContext = withUserContextInstructionFiles({ ...base, scenario }, sourceFiles)
          for await (const _event of query({
            messages: [createUserMessage({ content: 'answer' })], userContext, systemContext: {}, systemPrompt: asSystemPrompt([]),
            canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), toolUseContext, querySource: 'repl_main_thread',
            deps: {
              uuid: () => crypto.randomUUID(), microcompact: async messages => ({ messages }),
              autocompact: async messages => ({ messages, wasCompacted: false }),
              callModel: async function* (request) {
                await client.beta.messages.create({ model: 'claude-test', max_tokens: 8,
                  messages: normalizeMessagesForAPI(request.messages, []).map(message => message.message),
                } as any)
                yield createAssistantMessage({ content: 'answer' })
              },
            },
          })) { /* Drain the production context injection path. */ }
          expect(bodies).toHaveLength(1)
          const serialized = JSON.stringify(provider === 'anthropic' ? bodies[0].messages : bodies[0].input)
          expect(serialized).not.toContain('removed project marker')
          expect(serialized).not.toContain('removed import marker')
          expect(serialized).not.toContain('removed Claude marker')
          if (scenario === 'replace') {
            expect(serialized).toContain('first replacement marker')
            expect(serialized).toContain('second imported replacement marker')
            expect(serialized.indexOf('first replacement marker')).toBeLessThan(serialized.indexOf('second imported replacement marker'))
          } else if (scenario === 'unknown') expect(serialized).toContain('opaque replacement marker')
          else expect(serialized).not.toContain('# claudeMd')
        }
      }
      expect(diagnostics).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      getOpenAIAuthInfo.cache.clear?.()
      if (originalEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalEnv
      await runtime.dispose()
      getUserContext.cache.clear?.()
      clearMemoryFileCaches()
    }
  })

  test('agent generation includes both instruction sources in the model request', async () => {
    const project = join(root, 'agent-generation-project')
    mkdirSync(project)
    writeFileSync(join(project, 'AGENTS.md'), 'shared agent generation marker')
    writeFileSync(join(project, 'CLAUDE.md'), 'Claude agent generation marker')
    const { setOriginalCwd } = await import('../bootstrap/state.js')
    const { clearMemoryFileCaches } = await import('./claudemd.js')
    const { getUserContext } = await import('../context.js')
    const { createAssistantMessage } = await import('./messages.js')
    const api = await import('../services/api/claude.js')
    const { generateAgent } = await import('../components/agents/generateAgent.js')
    const generated = {
      identifier: 'fixture-agent',
      whenToUse: 'Use this agent for fixture checks',
      systemPrompt: 'Follow the project instructions',
    }
    const query = spyOn(api, 'queryModelWithoutStreaming').mockResolvedValue(
      createAssistantMessage({ content: JSON.stringify(generated) }),
    )
    const { enableConfigs } = await import('./config.js')
    enableConfigs()
    // Exercise context injection instead of prependUserContext's test shortcut.
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    setOriginalCwd(project)
    clearMemoryFileCaches()
    getUserContext.cache.clear?.()
    try {
      expect(
        await generateAgent(
          'review changed code',
          'claude-sonnet-4-6',
          [],
          new AbortController().signal,
        ),
      ).toEqual(generated)
      expect(query).toHaveBeenCalledTimes(1)
      const request = query.mock.calls[0]![0]
      const messages = JSON.stringify(request.messages)
      expect(messages).toContain('shared agent generation marker')
      expect(messages).toContain('Claude agent generation marker')
      const prompt = request.systemPrompt.join('\n')
      expect(prompt).toContain(
        'project-specific instructions from AGENTS.md and CLAUDE.md',
      )
      expect(prompt).toContain(
        'project-specific context from AGENTS.md and CLAUDE.md',
      )
      expect(prompt).toContain(
        'coding standards and patterns from AGENTS.md and CLAUDE.md',
      )
    } finally {
      query.mockRestore()
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
      getUserContext.cache.clear?.()
      clearMemoryFileCaches()
    }
  })

  test('loads nested AGENTS.md on demand alongside existing rules without duplicates', async () => {
    const project = join(root, 'nested-project')
    const nested = join(project, 'src')
    mkdirSync(join(nested, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(nested, 'AGENTS.md'), 'nested agents instructions')
    writeFileSync(join(nested, 'CLAUDE.md'), 'nested claude instructions')
    writeFileSync(
      join(nested, 'CLAUDE.local.md'),
      'private nested instructions',
    )
    writeFileSync(join(nested, '.claude', 'rules', 'general.md'), 'nested rule')
    const { setOriginalCwd, setAllowedSettingSources } =
      await import('../bootstrap/state.js')
    setOriginalCwd(project)
    setAllowedSettingSources(['projectSettings', 'localSettings'])
    const {
      clearMemoryFileCaches,
      getMemoryFiles,
      getMemoryFilesForNestedDirectory,
    } = await import('./claudemd.js')
    clearMemoryFileCaches()
    expect(await getMemoryFiles()).toEqual([])
    const processed = new Set<string>()
    const files = await getMemoryFilesForNestedDirectory(
      nested,
      join(nested, 'index.ts'),
      processed,
    )
    expect(files.map(file => file.path)).toEqual([
      join(nested, 'AGENTS.md'),
      join(nested, 'CLAUDE.md'),
      join(nested, 'CLAUDE.local.md'),
      join(nested, '.claude', 'rules', 'general.md'),
    ])
    expect(
      await getMemoryFilesForNestedDirectory(
        nested,
        join(nested, 'other.ts'),
        processed,
      ),
    ).toEqual([])
  })

  test('injects nested AGENTS.md as API attachments once and respects working-directory boundaries', async () => {
    const project = join(root, 'attachment-project')
    const nested = join(project, 'src')
    const outside = join(root, 'attachment-outside')
    mkdirSync(nested, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(nested, 'AGENTS.md'), 'nested shared attachment')
    writeFileSync(join(nested, 'CLAUDE.md'), 'nested Claude attachment')
    writeFileSync(join(nested, 'index.ts'), 'export {}')
    writeFileSync(join(outside, 'AGENTS.md'), 'outside instructions')
    writeFileSync(join(outside, 'index.ts'), 'export {}')
    const { setOriginalCwd, getCwdState, setCwdState } =
      await import('../bootstrap/state.js')
    const { clearMemoryFileCaches } = await import('./claudemd.js')
    const { getAttachments } = await import('./attachments.js')
    const { normalizeAttachmentForAPI } = await import('./messages.js')
    const { getDefaultAppState } = await import('../state/AppStateStore.js')
    const { createFileStateCacheWithSizeLimit } =
      await import('./fileStateCache.js')
    const originalCwd = getCwdState()
    setOriginalCwd(project)
    setCwdState(project)
    clearMemoryFileCaches()
    const state = getDefaultAppState()
    const context = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'claude-sonnet-4-6',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(10),
      nestedMemoryAttachmentTriggers: new Set([join(nested, 'index.ts')]),
      loadedNestedMemoryPaths: new Set<string>(),
      messages: [],
      getAppState: () => state,
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    } satisfies import('../Tool.js').ToolUseContext
    try {
      const attachments = (
        await getAttachments(null, context, null, [])
      ).filter(a => a.type === 'nested_memory')
      expect(attachments.map(a => a.path)).toEqual([
        join(nested, 'AGENTS.md'),
        join(nested, 'CLAUDE.md'),
      ])
      const messages = attachments.flatMap(normalizeAttachmentForAPI)
      expect(JSON.stringify(messages)).toContain('nested shared attachment')
      expect(JSON.stringify(messages)).toContain('nested Claude attachment')
      expect(context.nestedMemoryAttachmentTriggers.size).toBe(0)
      context.readFileState.clear()
      context.nestedMemoryAttachmentTriggers.add(join(nested, 'index.ts'))
      expect(
        (await getAttachments(null, context, null, [])).filter(
          a => a.type === 'nested_memory',
        ),
      ).toEqual([])
      context.nestedMemoryAttachmentTriggers.add(join(outside, 'index.ts'))
      expect(
        (await getAttachments(null, context, null, [])).filter(
          a => a.type === 'nested_memory',
        ),
      ).toEqual([])
    } finally {
      setCwdState(originalCwd)
      clearMemoryFileCaches()
    }
  })

  test.each(['AGENTS.md', 'CLAUDE.md', null])(
    'recognizes project onboarding instructions from %s',
    async filename => {
      const project = join(root, `onboarding-${filename ?? 'none'}`)
      mkdirSync(project)
      writeFileSync(join(project, 'index.ts'), 'export {}')
      if (filename)
        writeFileSync(join(project, filename), 'project instructions')
      const { getCwdState, setCwdState } = await import('../bootstrap/state.js')
      const { getSteps, isProjectOnboardingComplete } =
        await import('../projectOnboardingState.js')
      const cwd = getCwdState()
      try {
        setCwdState(project)
        expect(
          getSteps().find(step => step.key === 'claudemd')?.isComplete,
        ).toBe(filename !== null)
        expect(isProjectOnboardingComplete()).toBe(filename !== null)
      } finally {
        setCwdState(cwd)
      }
    },
  )

  test('loads AGENTS.md from additional directories only when enabled', async () => {
    const project = join(root, 'add-dir-project')
    const additional = join(root, 'additional')
    mkdirSync(project)
    mkdirSync(additional)
    writeFileSync(
      join(additional, 'AGENTS.md'),
      'additional agents instructions',
    )
    writeFileSync(
      join(additional, 'CLAUDE.md'),
      'additional claude instructions',
    )
    const { setOriginalCwd, setAdditionalDirectoriesForClaudeMd } =
      await import('../bootstrap/state.js')
    const { clearMemoryFileCaches, getMemoryFiles } =
      await import('./claudemd.js')
    setOriginalCwd(project)
    setAdditionalDirectoriesForClaudeMd([additional])
    try {
      clearMemoryFileCaches()
      expect(await getMemoryFiles()).toEqual([])
      process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
      clearMemoryFileCaches()
      expect((await getMemoryFiles()).map(file => file.path)).toEqual([
        join(additional, 'AGENTS.md'),
        join(additional, 'CLAUDE.md'),
      ])
    } finally {
      delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
      setAdditionalDirectoriesForClaudeMd([])
      clearMemoryFileCaches()
    }
  })

  test('recognizes previously read nested AGENTS.md as an instruction file', async () => {
    const { getAllMemoryFilePaths, isMemoryFilePath } =
      await import('./claudemd.js')
    const { createFileStateCacheWithSizeLimit } =
      await import('./fileStateCache.js')
    const path = join(root, 'project', 'src', 'AGENTS.md')
    const cache = createFileStateCacheWithSizeLimit(10)
    cache.set(path, {
      content: 'nested instructions',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    expect(isMemoryFilePath(path)).toBe(true)
    expect(isMemoryFilePath(join(root, 'README.md'))).toBe(false)
    expect(getAllMemoryFilePaths([], cache)).toEqual([path])
  })

  test('shares include deduplication and external approval boundaries across both files', async () => {
    const project = join(root, 'includes-project')
    mkdirSync(project)
    const shared = join(project, 'shared.md')
    const external = join(root, 'external.md')
    writeFileSync(shared, 'shared instructions')
    writeFileSync(external, 'external instructions')
    writeFileSync(
      join(project, 'AGENTS.md'),
      'agents instructions\n@./shared.md\n@../external.md',
    )
    writeFileSync(
      join(project, 'CLAUDE.md'),
      'claude instructions\n@./shared.md\n@./AGENTS.md',
    )
    const { setOriginalCwd } = await import('../bootstrap/state.js')
    const {
      clearMemoryFileCaches,
      getExternalClaudeMdIncludes,
      getMemoryFiles,
    } = await import('./claudemd.js')
    setOriginalCwd(project)
    clearMemoryFileCaches()
    const files = await getMemoryFiles()
    expect(files.map(file => file.path)).toEqual([
      join(project, 'AGENTS.md'),
      shared,
      join(project, 'CLAUDE.md'),
    ])
    expect(getExternalClaudeMdIncludes(files)).toEqual([])
    expect(getExternalClaudeMdIncludes(await getMemoryFiles(true))).toEqual([
      { path: external, parent: join(project, 'AGENTS.md') },
    ])
  })

  test.each(['AGENTS.md', 'CLAUDE.md'])(
    'deduplicates a symlink to %s',
    async target => {
      const project = join(root, `symlink-${target}`)
      mkdirSync(project)
      writeFileSync(join(project, target), 'shared file instructions')
      symlinkSync(
        target,
        join(project, target === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'),
      )
      const { setOriginalCwd } = await import('../bootstrap/state.js')
      const { clearMemoryFileCaches, getMemoryFiles } =
        await import('./claudemd.js')
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      expect(files.map(file => file.content)).toEqual([
        'shared file instructions',
      ])
    },
  )

  test('loads a normalized path once even when realpath removes a redundant segment', async () => {
    const project = join(root, 'normalized-project')
    mkdirSync(project)
    writeFileSync(join(project, 'AGENTS.md'), 'normalized instructions')
    const { processMemoryFile } = await import('./claudemd.js')
    const processed = new Set<string>()
    const files = await processMemoryFile(
      `${project}/./AGENTS.md`,
      'Project',
      processed,
      false,
    )
    expect(files.map(file => file.content)).toEqual(['normalized instructions'])
    expect(
      await processMemoryFile(
        join(project, 'AGENTS.md'),
        'Project',
        processed,
        false,
      ),
    ).toEqual([])
  })

  test('applies project setting-source and exclusion controls to AGENTS.md', async () => {
    const project = join(root, 'controlled-project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, 'AGENTS.md'), 'agents instructions')
    writeFileSync(join(project, 'CLAUDE.md'), 'claude instructions')
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        claudeMdExcludes: ['**/AGENTS.md'],
      }),
    )
    const { setOriginalCwd, setAllowedSettingSources } =
      await import('../bootstrap/state.js')
    const { resetSettingsCache } = await import('./settings/settingsCache.js')
    const {
      clearMemoryFileCaches,
      getMemoryFiles,
      getMemoryFilesForNestedDirectory,
    } = await import('./claudemd.js')
    setOriginalCwd(project)
    resetSettingsCache()
    clearMemoryFileCaches()
    expect((await getMemoryFiles()).map(file => file.path)).toEqual([
      join(project, 'CLAUDE.md'),
    ])
    expect(
      (
        await getMemoryFilesForNestedDirectory(
          project,
          join(project, 'index.ts'),
          new Set(),
        )
      ).map(file => file.path),
    ).toEqual([join(project, 'CLAUDE.md')])
    setAllowedSettingSources([])
    resetSettingsCache()
    clearMemoryFileCaches()
    try {
      expect(await getMemoryFiles()).toEqual([])
      expect(
        await getMemoryFilesForNestedDirectory(
          project,
          join(project, 'index.ts'),
          new Set(),
        ),
      ).toEqual([])
    } finally {
      setAllowedSettingSources(['projectSettings', 'localSettings'])
      resetSettingsCache()
      clearMemoryFileCaches()
    }
  })
}
