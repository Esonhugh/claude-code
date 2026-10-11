import { expect, test } from 'bun:test'
import { SDKControlInitializeRequestSchema, SDKControlInitializeResponseSchema } from './controlSchemas.js'

// Official 2.1.292 stdio captures: launch-plugin commands load before initialize;
// empty plugin lists omit plugins_applied; repeated requests only report admission.
test('initialize schema retains typed launch plugin descriptors', () => {
  const plugins = [{ type: 'local' as const, path: './plugin', skipMcpDiscovery: true }]
  expect(SDKControlInitializeRequestSchema().parse({ subtype: 'initialize', plugins }).plugins).toEqual(plugins)
  expect(SDKControlInitializeRequestSchema().safeParse({ subtype: 'initialize', plugins: [{ type: 'local', path: 4 }] }).success).toBe(false)
})

test('initialize response schema retains plugins_applied', () => {
  const field = SDKControlInitializeResponseSchema().shape.plugins_applied
  expect(field).toBeDefined()
  expect(field?.parse(true)).toBe(true)
  expect(field?.parse(undefined)).toBeUndefined()
})

import { afterEach } from 'bun:test'
import { captureLaunchInitialize, getInitializePluginsApplied } from './launchInitialize.js'
import type { SDKControlInitializeRequest, SDKControlInitializeResponse } from './controlTypes.js'
import { getSideloadStartupError } from '../../utils/plugins/sideloadPolicy.js'
import { resetSettingsCache, setCachedSettingsForSource } from '../../utils/settings/settingsCache.js'

const entry = { type: 'local' as const, path: './plugin' }
const initialize = (plugins: unknown = [entry]) => JSON.stringify({ type: 'control_request', request_id: 'launch', request: { subtype: 'initialize', plugins } })
async function* chunks(...values: string[]) { yield* values }
async function collect(source: AsyncIterable<string>) { let text = ''; for await (const chunk of source) text += chunk; return text }
afterEach(resetSettingsCache)

test('launch plugin request and receipt have explicit SDK types', () => {
  const request: SDKControlInitializeRequest = { subtype: 'initialize', plugins: [entry] }
  const skip: boolean | undefined = request.plugins?.[0]?.skipMcpDiscovery
  const receipt: Pick<SDKControlInitializeResponse, 'plugins_applied'> = { plugins_applied: true }
  expect(skip).toBeUndefined()
  expect(receipt.plugins_applied).toBe(true)
})

test('peeking skips blank lines, preserves chunk boundaries and splits MCP admission', async () => {
  const line = initialize([entry, { ...entry, path: './other', skipMcpDiscovery: true }])
  const values = ['\n \r\n' + line.slice(0, 20), line.slice(20) + '\n尾', '部\n']
  const capture = captureLaunchInitialize(chunks(...values))
  expect(await capture.ready).toEqual({ kind: 'applied', pluginDirs: ['./plugin'], pluginDirsNoMcp: ['./other'], pluginCount: 2 })
  const replay: string[] = []
  for await (const value of capture.input) replay.push(value)
  expect(replay).toEqual(values)
})

test('startup keeps draining, then adopts the in-flight read exactly once', async () => {
  let release!: (text: string) => void
  let draining!: () => void
  const drained = new Promise<void>(resolve => { draining = resolve })
  const tail = new Promise<string>(resolve => { release = resolve })
  let reads = 0
  async function* input() {
    reads++; yield initialize() + '\n'
    reads++; draining(); yield await tail
    reads++
  }
  const capture = captureLaunchInitialize(input())
  expect((await capture.ready).kind).toBe('applied')
  await drained
  const replay = collect(capture.input)
  release('USER_TAIL\n')
  expect(await replay).toBe(initialize() + '\nUSER_TAIL\n')
  expect(reads).toBe(3)
})

test.each(['', initialize(), '\n  \n' + initialize()])('EOF without a complete first line does not apply launch plugins (%#)', async text => {
  const capture = captureLaunchInitialize(chunks(text))
  expect(await capture.ready).toEqual({ kind: 'absent' })
  expect(await collect(capture.input)).toBe(text)
})

test.each([
  ['not json\n', 'the first line is not valid JSON.'],
  ['{"type":"keep_alive"}\n', 'the first line is a different message.'],
  [initialize([{ type: 'local', path: 4 }]) + '\n', 'initialize.plugins must be an array'],
  [initialize([{ ...entry, skipMcpDiscovery: 'true' }]) + '\n', 'initialize.plugins must be an array'],
  [initialize(null) + '\n', 'initialize.plugins must be an array'],
])('invalid launch request has the official error and retains stdin (%#)', async (text, error) => {
  const capture = captureLaunchInitialize(chunks(text))
  const result = await capture.ready
  expect(result.kind).toBe('violation')
  if (result.kind === 'violation') expect(result.message).toContain(error)
  expect(await collect(capture.input)).toBe(text)
})

test('stdin read errors remain visible to the adopted SDK reader', async () => {
  const error = new Error('owned input error')
  async function* input() { yield initialize() + '\n'; throw error }
  const capture = captureLaunchInitialize(input())
  expect((await capture.ready).kind).toBe('applied')
  await expect(collect(capture.input)).rejects.toBe(error)
})

test('plugins_applied distinguishes path categories and does not load on repeats', () => {
  const loaded = ['./plugin']
  expect(getInitializePluginsApplied([entry], loaded, [], '/cwd')).toBe(true)
  expect(getInitializePluginsApplied([{ ...entry, path: '/cwd/plugin' }], loaded, [], '/cwd')).toBe(true)
  expect(getInitializePluginsApplied([{ ...entry, skipMcpDiscovery: true }], loaded, [], '/cwd')).toBe(false)
  expect(getInitializePluginsApplied([{ ...entry, skipMcpDiscovery: true }], [], loaded, '/cwd')).toBe(true)
  expect(getInitializePluginsApplied([entry], [], loaded, '/cwd')).toBe(false)
  expect(getInitializePluginsApplied([entry], [], [], '/cwd')).toBe(false)
  expect(getInitializePluginsApplied([], loaded, [])).toBeUndefined()
  expect(getInitializePluginsApplied(undefined, loaded, [])).toBeUndefined()
  expect(getInitializePluginsApplied(null, loaded, [])).toBe(false)
  expect(loaded).toEqual(['./plugin'])
})

test('managed policy refuses initialize plugins in official flag order', () => {
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: true })
  expect(getSideloadStartupError({}, [], {}, 1)).toStartWith('plugins (initialize request) is disabled')
  expect(getSideloadStartupError({ pluginDir: ['cli'] }, ['env'], {}, 2)).toStartWith('--plugin-dir, plugins (initialize request), CLAUDE_CODE_PLUGIN_DIRS are disabled')
  expect(getSideloadStartupError({}, [], {}, 0)).toBeUndefined()
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: false })
  expect(getSideloadStartupError({}, [], {}, 1)).toBeUndefined()
})
