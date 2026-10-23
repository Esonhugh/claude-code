import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_SDK_CONTROL_REQUESTS_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('newer Agent SDK control requests (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-sdk-control-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=UDS_INBOX', '--feature=KAIROS_CHANNELS', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      console.log(`${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const { readFileSync } = await import('node:fs')

  async function run(requests: Record<string, unknown>[]) {
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const frames: StdoutMessage[] = []
    const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        frames.push(message)
        if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve()
      }),
    ]
    async function* input() {
      for (const [i, request] of requests.entries()) {
        receipts.set(String(i), Promise.withResolvers<void>())
        yield JSON.stringify({ type: 'control_request', request_id: String(i), request }) + '\n'
        await receipts.get(String(i))!.promise
      }
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    return frames.filter(frame => frame.type === 'control_response').map(frame => frame.response as Record<string, any>)
  }

  test('reload_skills and reload_output_styles answer instead of Unsupported', async () => {
    const [skills, styles] = await run([{ subtype: 'reload_skills' }, { subtype: 'reload_output_styles' }])
    expect(skills.subtype).toBe('success')
    expect(Array.isArray(skills.response.skills)).toBe(true)
    expect(styles.subtype).toBe('success')
    expect(styles.response.available_output_styles).toContain('default')
  })

  test('read_file uses the Read permission gate, max_bytes and base64', async () => {
    const [text, cut, b64, outside, missing] = await run([
      { subtype: 'read_file', path: 'package.json' },
      { subtype: 'read_file', path: 'package.json', max_bytes: 5 },
      { subtype: 'read_file', path: 'package.json', max_bytes: 3, encoding: 'base64' },
      { subtype: 'read_file', path: '/etc/hostname' },
      { subtype: 'read_file' },
    ])
    expect(text.subtype).toBe('success')
    expect(text.response.contents).toBe(readFileSync('package.json', 'utf-8'))
    expect(text.response.absPath).toBe(join(process.cwd(), 'package.json'))
    expect(text.response.truncated).toBeUndefined()
    expect(cut.response).toMatchObject({ contents: readFileSync('package.json', 'utf-8').slice(0, 5), truncated: true })
    expect(b64.response).toMatchObject({ contents: readFileSync('package.json').subarray(0, 3).toString('base64'), encoding: 'base64' })
    expect(outside).toMatchObject({ subtype: 'error', error: 'read_file: permission denied for /etc/hostname' })
    expect(missing).toMatchObject({ subtype: 'error', error: 'read_file: path is required' })
  })

  test('update_settings writes only the allowlisted key', async () => {
    const responses = await run([
      { subtype: 'update_settings', source: 'userSettings', settings: { effortLevel: 'low' } },
      { subtype: 'update_settings', source: 'userSettings', settings: { effortLevel: 'max' } },
      { subtype: 'update_settings', source: 'userSettings', settings: { permissions: { allow: ['Bash'] } } },
      { subtype: 'update_settings', source: 'policySettings', settings: { outputStyle: 'x' } },
      { subtype: 'update_settings', source: 'localSettings', settings: { outputStyle: 'x', model: 'y' } },
    ])
    expect(responses.map(r => r.subtype)).toEqual(['success', 'error', 'error', 'error', 'error'])
    const saved = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf-8'))
    expect(saved).toEqual({ effortLevel: 'low' })
  })

  test('mcp_read_resource only reads ui:// resources from known servers', async () => {
    const [scheme, unknown] = await run([
      { subtype: 'mcp_read_resource', serverName: 'nosuch', uri: 'file:///etc/passwd' },
      { subtype: 'mcp_read_resource', serverName: 'nosuch', uri: 'ui://widget' },
    ])
    expect(scheme).toMatchObject({ subtype: 'error', error: 'mcp_read_resource: uri must use the ui:// scheme' })
    expect(unknown).toMatchObject({ subtype: 'error', error: 'mcp_read_resource: no connected server named nosuch' })
  })
}
