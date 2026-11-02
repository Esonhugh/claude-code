import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModHostServices } from './runtime.js'
import { createModRemoteUiHost, type ModRemoteAnsweringClient, type ModRemoteUiAsk } from './remoteUiAsk.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR'] as const
const prior = new Map<string, string | undefined>()
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'remote-ui-ask-')))
  for (const key of keys) prior.set(key, process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'cache')
})
afterEach(async () => {
  try { await Promise.all(runtimes.splice(0).map(value => value.dispose())) }
  finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    prior.clear()
    await rm(root, { recursive: true, force: true })
  }
})

type Sent = Parameters<ModRemoteUiAsk>[0]
const desktop = (clientId: string): ModRemoteAnsweringClient => ({ clientId, surface: 'desktop' })

test('asks only the first client that answers a request and reads its composer', async () => {
  const sent: Sent[] = []
  const host = createModRemoteUiHost({
    clients: () => [desktop('a'), desktop('b')],
    ask: async request => { sent.push(request); return { text: 'draft', cursor: 99 } },
  })
  expect(await host.prompt.read()).toEqual({ text: 'draft', cursor: 5 })
  expect(sent).toEqual([{ subtype: 'ui_prompt_read', surface: 'desktop', client_id: 'a' }])
})

test('an unanswered read is the empty box and an unanswered fill or suggest is false', async () => {
  const host = createModRemoteUiHost({ clients: () => [desktop('a')], ask: async () => undefined })
  expect(await host.prompt.read()).toEqual({ text: '', cursor: 0 })
  expect(await host.prompt.fill({ text: 'x', mode: 'replace' })).toEqual({ isFilled: false })
  expect(await host.prompt.suggest!('x', 'owner')).toBe(false)
  expect(await host.copy('x', 'desktop', 'p')).toBe(false)
  expect(await host.selection()).toBeUndefined()
})

test('no answering client: fill refuses no_composer and copy reports nobody there', async () => {
  const sent: Sent[] = []
  const host = createModRemoteUiHost({ clients: () => [], ask: async request => { sent.push(request); return {} } })
  expect(await host.prompt.fill({ text: 'x', mode: 'append' })).toEqual({ isFilled: false, refusal: 'no_composer' })
  expect(await host.copy('x', 'desktop', 'p')).toBeUndefined()
  expect(await host.prompt.read()).toEqual({ text: '', cursor: 0 })
  expect(sent).toEqual([])
})

test('fill carries mode and normalized decorations, omitting an empty list', async () => {
  const sent: Sent[] = []
  const host = createModRemoteUiHost({
    clients: () => [desktop('a')],
    ask: async request => { sent.push(request); return { filled: true } },
  })
  expect(await host.prompt.fill({ text: 'hello', mode: 'insert', decorations: [{ start: 0, end: 99, bold: true }] })).toEqual({ isFilled: true })
  expect(await host.prompt.fill({ text: 'hi', mode: 'replace', decorations: [] })).toEqual({ isFilled: true })
  expect(sent).toEqual([
    { subtype: 'ui_prompt_fill', surface: 'desktop', client_id: 'a', text: 'hello', mode: 'insert', decorations: [{ start: 0, end: 5, bold: true }] },
    { subtype: 'ui_prompt_fill', surface: 'desktop', client_id: 'a', text: 'hi', mode: 'replace' },
  ])
})

test('selection asks every answering client at once and takes the first non-empty answer', async () => {
  const sent: string[] = []
  const host = createModRemoteUiHost({
    clients: () => [desktop('empty'), desktop('slow'), desktop('fast')],
    ask: async request => {
      sent.push(request.client_id)
      if (request.client_id === 'empty') return {}
      if (request.client_id === 'slow') { await Bun.sleep(30); return { text: 'late' } }
      return { text: 'picked', instance_id: 'row-1' }
    },
  })
  expect(await host.selection()).toEqual({ text: 'picked', requestId: 'row-1' })
  expect(sent).toEqual(['empty', 'slow', 'fast'])
})

async function headless(body: string, services: ModHostServices) {
  const pluginRoot = join(root, 'caller'); await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on){on('command.run',async($,e)=>{${body}})}`)
  const value = createModsRuntime({ services })
  runtimes.push(value)
  await value.bind({ cwd: root, surface: null, isInteractive: false, sessionId: 'remote-ask' })
  await value.reconcile([{ name: 'remote-caller', storageId: 'remote-caller@test', pluginRoot, entrypoints: [entry] }])
  return { value, run: async () => JSON.parse((await value.dispatch('command.run', {}, async () => ({ text: 'unhandled' })) as { text: string }).text) }
}

const body = `return {text:JSON.stringify({
  read: await $.prompt.read(),
  fill: await $.prompt.fill({text:'rewritten',mode:'replace'}),
  suggest: await $.prompt.suggest({text:'next step'}),
  copy: await $.ui.copy({text:'clip',surface:'desktop'}),
  selection: (await $.ui.selection()) ?? null,
})}`

test('a headless plugin reaches the attached client composer, clipboard and selection', async () => {
  const sent: Sent[] = []
  let draft = 'typed'
  const bound: { runtime?: ReturnType<typeof createModsRuntime> } = {}
  const host = createModRemoteUiHost({
    clients: (answer, surface) => bound.runtime!.remoteClients.answering(answer, surface),
    ask: async request => {
      sent.push(request)
      switch (request.subtype) {
        case 'ui_prompt_read': return { text: draft, cursor: draft.length }
        case 'ui_prompt_fill': draft = request.text as string; return { filled: true }
        case 'ui_prompt_suggest': return { shown: true }
        case 'ui_copy': return { copied: true }
        case 'ui_read_selection': return { text: 'chosen' }
      }
    },
  })
  const { value, run } = await headless(body, {
    prompt: () => host.prompt,
    uiSelection: () => host.selection(),
    uiCopy: async ({ text, surface }, plugin) =>
      surface !== 'terminal' && await host.copy(text, surface, plugin) ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' },
  })
  bound.runtime = value
  value.remoteClients.attach({ surface: 'desktop', clientId: 'silent' })
  value.remoteClients.attach({
    surface: 'desktop', clientId: 'web',
    answers: ['ui_copy', 'ui_prompt_read', 'ui_prompt_fill', 'ui_prompt_paint', 'ui_prompt_suggest', 'ui_read_selection'],
  })
  expect(await run()).toEqual({
    read: { text: 'typed', cursor: 5 },
    fill: { isFilled: true, text: 'rewritten', cursor: 9 },
    suggest: { isShown: true },
    copy: { isCopied: true },
    selection: { text: 'chosen' },
  })
  expect(sent.map(request => [request.subtype, request.client_id])).toEqual([
    ['ui_prompt_read', 'web'],
    ['ui_prompt_fill', 'web'],
    ['ui_prompt_read', 'web'],
    ['ui_prompt_suggest', 'web'],
    ['ui_copy', 'web'],
    ['ui_read_selection', 'web'],
  ])
  expect(sent[4]).toEqual({ subtype: 'ui_copy', surface: 'desktop', client_id: 'web', plugin: 'remote-caller', text: 'clip' })
})

test('a headless session without the remote host keeps the empty composer', async () => {
  const { value, run } = await headless(body, {})
  value.remoteClients.attach({ surface: 'desktop', clientId: 'web', answers: ['ui_prompt_read', 'ui_prompt_fill'] })
  expect(await run()).toEqual({
    read: { text: '', cursor: 0 },
    fill: { isFilled: false, refusal: 'no_composer', text: '', cursor: 0 },
    suggest: { isShown: false },
    copy: { isCopied: false, reason: 'no-clipboard' },
    selection: null,
  })
})
