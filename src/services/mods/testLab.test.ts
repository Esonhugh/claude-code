import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { ModUiCallback, ModUiInteraction, ModUiPane } from './ui.js'

const sample = new URL('../../../examples/mods/mods-test-lab/', import.meta.url).pathname.replace(/\/$/, '')
const entry = join(sample, 'hooks/register.ts')
const pluginId = 'mods-test-lab@inline'
const marker = '[mods-test-lab: one-shot context]'
const childFlag = 'CLAUDE_CODE_MODS_TEST_LAB_CHILD'
const officialTypes = process.env.CLAUDE_CODE_OFFICIAL_MOD_TYPES

if (!process.env[childFlag]) {
  test('actual Mods test lab files pass in an isolated credential-free host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-test-lab-suite-'))
    try {
      await mkdir(join(root, 'bin'))
      await writeFile(join(root, 'bin/security'), '#!/bin/sh\nexit 44\n', { mode: 0o700 })
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          XDG_CONFIG_HOME: join(root, 'xdg'),
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'plugins'),
          ANTHROPIC_API_KEY: 'mods-test-lab-fake-key',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          ...(officialTypes ? { CLAUDE_CODE_OFFICIAL_MOD_TYPES: officialTypes } : {}),
          [childFlag]: '1',
        },
        stdout: 'pipe', stderr: 'pipe', timeout: 55000,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      console.log(`${stdout}${stderr}`.trim())
      expect(code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { createModsRuntime } = await import('./runtime.js')
  const { loadModDeclaration } = await import('./loader.js')
  const { prepareModPlugins } = await import('./plugins.js')
  const { setOriginalCwd, setInlinePlugins } = await import('../../bootstrap/state.js')
  const { clearPluginCache, loadAllPluginsCacheOnly } = await import('../../utils/plugins/pluginLoader.js')
  const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
  const { getSettingsForSource } = await import('../../utils/settings/settings.js')
  const { disablePluginOp, enablePluginOp } = await import('../plugins/pluginOperations.js')
  const { pluginDataDirPath } = await import('../../utils/plugins/pluginDirectories.js')
  const home = process.env.HOME!
  const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']
  let saved: (string | undefined)[]
  let root: string
  let runtime: ReturnType<typeof createModsRuntime>
  let diagnostics: unknown[]
  let logs: unknown[]
  let presentation = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }

  beforeEach(async () => {
    root = await mkdtemp(join(home, 'case-'))
    saved = envKeys.map(key => process.env[key])
    process.env.HOME = root
    process.env.USERPROFILE = root
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'plugins')
    process.chdir(root)
    setOriginalCwd(root)
    setInlinePlugins([sample])
    resetSettingsCache()
    clearPluginCache()
    diagnostics = []
    logs = []
    presentation = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
    runtime = createModsRuntime({
      onDiagnostic: event => diagnostics.push(event),
      services: {
        uiPresentation: () => presentation,
        uiLog: (plugin, text) => { logs.push([plugin, text]) },
        uiStatus: (plugin, text) => { logs.push([plugin, text]) },
      },
    })
    await runtime.bind({ cwd: root, sessionId: 'test-lab', surface: 'terminal', isInteractive: true })
  })

  afterEach(async () => {
    try { await runtime.dispose() }
    finally {
      setInlinePlugins([])
      clearPluginCache()
      resetSettingsCache()
      process.chdir(home)
      setOriginalCwd(home)
      envKeys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]
        else process.env[key] = saved[i]
      })
      await rm(root, { recursive: true, force: true })
    }
  })

  async function discover() {
    clearPluginCache()
    const plugins = await loadAllPluginsCacheOnly()
    expect(plugins.errors).toEqual([])
    const prepared = prepareModPlugins(plugins.enabled, {
      userSettings: getSettingsForSource('userSettings'),
      flagSettings: {}, policySettings: {}, hookPolicy: { managedOnly: false, allDisabled: false },
    })
    expect(prepared.errors).toEqual([])
    return { ...plugins, inputs: prepared.inputs }
  }

  async function activate() {
    const found = await discover()
    expect(found.enabled.map(plugin => plugin.source)).toEqual([pluginId])
    expect(found.inputs).toHaveLength(1)
    await runtime.reconcile(found.inputs)
    expect(diagnostics).toEqual([])
    return found
  }

  async function run(args = '') {
    const command = runtime.commands.list().find(command => command.name === 'mods-test')!
    expect(command).toMatchObject({ type: 'local-jsx', immediate: true })
    if (command.type !== 'local-jsx') throw new Error('Expected immediate local command')
    const completions: (string | undefined)[] = []
    const module = await command.load()
    expect(await module.call(text => { completions.push(text) }, {
      abortController: new AbortController(),
      modCommand: { origin: { kind: 'composer' }, presentation },
    } satisfies Pick<LocalJSXCommandContext, 'abortController' | 'modCommand'> as unknown as LocalJSXCommandContext, args)).toBeNull()
    expect(completions).toHaveLength(1)
    return completions[0]
  }

  type Tree = { type: string; props?: Record<string, unknown>; children?: (Tree | string)[]; press?: ModUiCallback }
  function text(node: unknown): string {
    if (typeof node === 'string') return node
    return ((node as Tree)?.children ?? []).map(text).join('\n')
  }
  function control(pane: ModUiPane, key: string): Tree {
    const children = (pane.tree as Tree).children as Tree[]
    const node = children.find(node => node.props?.key === key)
    expect(node?.press).toBeDefined()
    return node!
  }
  async function interact(key: string, kind: ModUiInteraction, value?: string) {
    const pane = runtime.ui.getSnapshot()[0]!
    await runtime.ui.interact(pane.id, pane.drawing!, control(pane, key).press!, kind, key, value)
  }
  function state(summary: string) {
    const json = (label: string) => JSON.parse(summary.split('\n').find(line => line.startsWith(label))!.slice(label.length))
    return {
      counts: json('Activation counters (since load/reset): '),
      persistent: json('Persistent counters (since reset; activations retained): '),
      controls: json('Controls: '),
      events: summary.split('\n').find(line => line.startsWith('Events ('))!,
    }
  }
  function storePath(id = pluginId) {
    return join(pluginDataDirPath(id), `mod-store-${createHash('sha256').update(id).digest('hex')}.json`)
  }
  async function store() {
    return Object.fromEntries(JSON.parse(await readFile(storePath(), 'utf8')))
  }

  test('discovers the actual manifest and module, admits capabilities, and starts without a pane', async () => {
    const found = await activate()
    expect(found.enabled[0]).toMatchObject({
      name: 'mods-test-lab', path: sample, manifest: { name: 'mods-test-lab', version: '0.1.0' },
      hookModules: [{ configPath: join(sample, 'hooks/hooks.json'), paths: ['./register.ts'] }],
    })
    const declaration = await loadModDeclaration(found.inputs[0]!)
    expect(declaration.modules.map(module => module.path)).toEqual([entry])
    expect(declaration.calls).toEqual(['command.register', 'store.get', 'store.set', 'ui.close', 'ui.invalidate', 'ui.open', 'ui.resolve'])
    expect(runtime.commands.list()).toHaveLength(1)
    expect(runtime.commands.list()[0]).toMatchObject({ name: 'mods-test', immediate: true, argumentHint: '[open|status|reset|close|context]' })
    expect(runtime.ui.getSnapshot()).toEqual([])
    expect(await store()).toEqual({ counters: { activations: 1, command: 0, tool: 0, prompt: 0, turn: 0 } })
    const status = await run('status')
    expect(state(status!).counts).toEqual({ command: 1, tool: 0, prompt: 0, turn: 0 })
    expect(status).toContain('activation=1')
    expect(runtime.ui.getSnapshot()).toEqual([])
    expect(await run('unrecognized CANARY-ARG')).toBe('/mods-test [open|status|reset|close|context]')
    expect(logs).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('opens real Worker controls, focuses, scrolls, redraws purely at narrow width, and closes', async () => {
    await activate()
    expect(await run()).toBeUndefined()
    const first = runtime.ui.getSnapshot()[0]!
    expect(first).toMatchObject({ id: 'mods-test-lab', visible: true, focused: true, placement: 'dock' })
    expect(text(first.tree)).toContain('- 旧行：你好世界')
    expect(text(first.tree)).toContain('+ 新行：宽度测试')
    expect(text(first.tree)).toContain('Row 60 | fixed scroll fixture')
    expect((first.tree as Tree).children!.filter(node => typeof node === 'object' && text(node).startsWith('Row '))).toHaveLength(60)
    await interact('count', 'press')
    expect(control(runtime.ui.getSnapshot()[0]!, 'count').props?.label).toBe('Count: 1')
    await expect(runtime.ui.interact(first.id, first.drawing!, control(first, 'count').press!, 'press', 'count')).rejects.toThrow(/stale/)
    const pane = runtime.ui.getSnapshot()[0]!
    expect(await runtime.ui.focus(pane.owner, { requestId: pane.id, element: 'input', origin: { kind: 'person' } }, presentation)).toMatchObject({ focused: true, element: 'input' })
    await interact('input', 'input.change', 'CANARY-INPUT')
    await interact('input', 'input.submit', 'CANARY-INPUT')
    await interact('selection', 'select', 'cjk')
    const current = runtime.ui.getSnapshot()[0]!
    expect(control(current, 'input').props?.value).toBe('CANARY-INPUT')
    expect(control(current, 'selection').props?.value).toBe('cjk')
    expect(state(text(current.tree)).controls).toEqual({ button: 1, input: 1, submit: 1, select: 1 })
    expect(text(current.tree)).toContain('固定示例差异 / CJK diff')
    expect(text(current.tree)).not.toContain('CANARY-INPUT')
    await runtime.ui.reportMetrics(current.id, { bodyRows: 8, contentRows: 80 })
    await runtime.ui.scroll(current.owner, { requestId: current.id, by: 5, pointer: { column: 2, row: 3 }, origin: { kind: 'person' } })
    expect(runtime.ui.getSnapshot()[0]!.scrollOffset).toBe(5)
    const beforeStore = await readFile(storePath(), 'utf8')
    const beforeState = text(runtime.ui.getSnapshot()[0]!.tree)
    presentation = { ...presentation, columns: 38, rows: 20, isFullscreen: false }
    await runtime.ui.render(presentation)
    await runtime.ui.render(presentation)
    expect(runtime.ui.getSnapshot()[0]).toMatchObject({ visible: true, placement: 'inline' })
    expect(text(runtime.ui.getSnapshot()[0]!.tree)).toBe(beforeState)
    expect(await readFile(storePath(), 'utf8')).toBe(beforeStore)
    expect(logs).toEqual([])
    await interact('close', 'press')
    expect(runtime.ui.getSnapshot()).toEqual([])
    await run('open')
    await run('close')
    expect(runtime.ui.getSnapshot()).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('observes tools exactly once and preserves input, success, and error results without recording content', async () => {
    await activate()
    let calls = 0
    for (const result of [
      { result: { content: 'CANARY-RESULT', nested: [1, { value: true }] } },
      { result: 'CANARY-TOOL-ERROR', isError: true },
    ]) {
      const input = { tool: 'Read', tool_use_id: 'CANARY-ID', file_path: 'CANARY-PATH', nested: { value: 'CANARY-ARGS' } }
      const original = structuredClone(input)
      expect(await runtime.dispatch('tool.call', input, async event => {
        calls++
        expect(event).toEqual(original)
        return result
      })).toEqual(result)
      expect(input).toEqual(original)
    }
    expect(calls).toBe(2)
    const turn = { reason: 'aborted', isAborted: true, durationMs: 1, turnId: 'CANARY-TURN-ID', answer: 'CANARY-ANSWER' }
    expect(await runtime.dispatch('turn.complete', turn, async event => {
      expect(event).toEqual(turn)
      return { text: turn.answer }
    })).toEqual({ text: turn.answer })
    const status = (await run('status'))!
    expect(state(status).counts).toEqual({ command: 1, tool: 2, prompt: 0, turn: 1 })
    expect(await store()).toEqual({ counters: { activations: 1, command: 1, tool: 2, prompt: 0, turn: 1 } })
    expect(status).toContain('Last turn: {"reason":"aborted","aborted":true}')
    expect(`${status}${await readFile(storePath(), 'utf8')}${JSON.stringify(logs)}`).not.toContain('CANARY-')
    expect(diagnostics).toEqual([])
  })

  test('explicit context is consumed once, preserves prior context, and is cleared by reset', async () => {
    await activate()
    const input = { text: 'CANARY-PROMPT', origin: { kind: 'composer' }, wait: false, context: ['existing-context'] }
    let calls = 0
    const submit = () => runtime.dispatch('prompt.submit', input, async event => {
      calls++
      expect(event.text).toBe(input.text)
      expect(event.origin).toEqual(input.origin)
      expect(event.wait).toBe(false)
      return { text: event.text, context: event.context, origin: event.origin }
    })
    expect(await submit()).toEqual({ text: input.text, context: input.context, origin: input.origin })
    expect(await run('context')).toBe('Mods test lab: fixed context armed for the next prompt only.')
    expect(await run('status')).toContain('context=pending')
    const pair = await Promise.all([submit(), submit()])
    expect(pair.map(result => (result as { context: string[] }).context)).toEqual([
      ['existing-context', marker], ['existing-context'],
    ])
    expect(input.context).toEqual(['existing-context'])
    expect(await run('status')).toContain('context=idle')
    await run('context')
    const reset = (await run('reset'))!
    expect(state(reset).counts).toEqual({ command: 0, tool: 0, prompt: 0, turn: 0 })
    expect(reset).toContain('context=idle')
    expect(await submit()).toEqual({ text: input.text, context: input.context, origin: input.origin })
    expect(calls).toBe(4)
    expect(`${await run('status')}${await readFile(storePath(), 'utf8')}${JSON.stringify(logs)}`).not.toContain('CANARY-')
    expect(diagnostics).toEqual([])
  })

  test('bounds events and input, resets only its own counters, and retains activation identity', async () => {
    await activate()
    const other = storePath('other-plugin@inline')
    await mkdir(pluginDataDirPath('other-plugin@inline'), { recursive: true })
    await writeFile(other, '[["unrelated",17]]')
    await run('open')
    await interact('input', 'input.change', 'x'.repeat(300))
    expect(control(runtime.ui.getSnapshot()[0]!, 'input').props?.value).toBe('x'.repeat(256))
    await interact('selection', 'select', 'cjk')
    for (let i = 0; i < 25; i++) await interact('count', 'press')
    const status = (await run('status'))!
    expect(state(status).events).toBe(`Events (20/20): ${[...Array(19).fill('button'), 'status'].join(', ')}`)
    expect(state(status).controls).toEqual({ button: 25, input: 1, submit: 0, select: 1 })
    await run('context')
    const reset = (await run('reset'))!
    expect(state(reset)).toEqual({
      counts: { command: 0, tool: 0, prompt: 0, turn: 0 },
      persistent: { activations: 1, command: 0, tool: 0, prompt: 0, turn: 0 },
      controls: { button: 0, input: 0, submit: 0, select: 0 },
      events: 'Events (0/20): ',
    })
    expect(reset).toContain('Input length=0/256 | selection=ascii | context=idle')
    expect(reset).toContain('Last turn: none')
    expect(control(runtime.ui.getSnapshot()[0]!, 'input').props?.value).toBe('')
    expect(control(runtime.ui.getSnapshot()[0]!, 'selection').props?.value).toBe('ascii')
    expect(control(runtime.ui.getSnapshot()[0]!, 'count').props?.label).toBe('Count: 0')
    expect(await store()).toEqual({ counters: state(reset).persistent })
    expect(await readFile(other, 'utf8')).toBe('[["unrelated",17]]')
    expect(logs).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('unchanged reload retains activation; real disable/enable retires UI and commands but keeps counters', async () => {
    const found = await activate()
    await run('open')
    await interact('count', 'press')
    await run('context')
    const old = runtime.ui.getSnapshot()[0]!
    const command = runtime.commands.list()[0]!
    const before = await store()
    await runtime.reconcile((await discover()).inputs)
    expect(runtime.commands.list()[0]).toBe(command)
    expect(runtime.ui.getSnapshot()[0]!.owner).toBe(old.owner)
    expect(await store()).toEqual(before)
    expect((await disablePluginOp(pluginId)).success).toBe(true)
    const disabled = await discover()
    expect(disabled.disabled.map(plugin => plugin.source)).toEqual([pluginId])
    expect(disabled.inputs).toEqual([])
    await runtime.reconcile(disabled.inputs)
    expect(runtime.commands.list()).toEqual([])
    expect(runtime.ui.getSnapshot()).toEqual([])
    await expect(runtime.ui.interact(old.id, old.drawing!, control(old, 'count').press!, 'press', 'count')).rejects.toThrow(/stale/)
    if (command.type !== 'local-jsx') throw new Error('Expected local command')
    await expect((await command.load()).call(() => {}, { abortController: new AbortController() } as LocalJSXCommandContext, 'status')).rejects.toThrow(/no longer active/)
    expect((await enablePluginOp(pluginId)).success).toBe(true)
    await runtime.reconcile((await discover()).inputs)
    expect(runtime.commands.list()[0]).not.toBe(command)
    expect(runtime.ui.getSnapshot()).toEqual([])
    expect(await store()).toEqual({ counters: { ...before.counters, activations: 2 } })
    const status = (await run('status'))!
    expect(state(status).counts).toEqual({ command: 1, tool: 0, prompt: 0, turn: 0 })
    expect(state(status).persistent).toEqual({ activations: 2, command: 3, tool: 0, prompt: 0, turn: 0 })
    expect(state(status).controls).toEqual({ button: 0, input: 0, submit: 0, select: 0 })
    expect(state(status).events).toBe('Events (2/20): activation, status')
    expect(status).toContain('context=idle')
    await run('open')
    expect(runtime.ui.getSnapshot()[0]!.owner).not.toBe(old.owner)
    await expect(runtime.ui.interact(old.id, old.drawing!, control(old, 'count').press!, 'press', 'count')).rejects.toThrow(/stale/)
    await runtime.reconcile(found.inputs)
    expect((await store()).counters.activations).toBe(2)
    expect(diagnostics).toEqual([])
  })

  test.skipIf(!officialTypes)('actual sample typechecks against the complete external author declarations', async () => {
    const config = join(root, 'tsconfig.json')
    await writeFile(config, JSON.stringify({
      compilerOptions: {
        target: 'es2023', lib: ['es2023'], types: [], module: 'esnext', moduleResolution: 'bundler',
        strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: false,
      },
      files: [officialTypes, entry],
    }))
    const compiler = Bun.spawn([
      process.execPath, new URL('../../../node_modules/typescript/bin/tsc', import.meta.url).pathname,
      '--project', config, '--pretty', 'false',
    ], { stdout: 'pipe', stderr: 'pipe', timeout: 15000 })
    const [exit, stdout, stderr] = await Promise.all([
      compiler.exited, new Response(compiler.stdout).text(), new Response(compiler.stderr).text(),
    ])
    if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
    expect(exit).toBe(0)
  }, 20000)
}
