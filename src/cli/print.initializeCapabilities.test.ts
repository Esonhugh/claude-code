import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_PRINT_CAPABILITIES_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('initialize discovers usable remote UI capabilities (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-print-capabilities-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_IS_COWORK|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_DISABLE_SESSION_PERSISTENCE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=UDS_INBOX', '--feature=KAIROS_CHANNELS', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      const summary = `${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)
      if (summary) console.log(summary[0])
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { createModsSession } = await import('../services/mods/session.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')

  test.each(['available', 'absent', 'untrusted', 'disabled'] as const)('initialize advertises only an available UI runtime: %s', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'cc-capability-plugin-'))
    writeFileSync(join(root, 'register.ts'), `export function register(on) {
      on('ui.render', {component:'ToolUse',surface:'desktop'}, ($,e) => $.ui.resolve(e).Button({
        key:'run',label:'Run',onPress:() => $.ui.log('CAPABILITY_PRESSED')
      }));
    }`)
    const session = mode === 'absent' ? undefined : createModsSession({
      isTrusted: mode !== 'untrusted',
      getDisabledReason: () => mode === 'disabled' ? 'fixture disabled' : undefined,
      getSettings: () => ({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),
      loadPlugins: async () => [{name:'capability-probe',manifest:{name:'capability-probe'},path:root,
        source:'capability-probe@inline',repository:'capability-probe@inline',enabled:true,
        hookModules:[{configPath:join(root,'hooks.json'),paths:['./register.ts']}]}],
    })
    const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<SDKControlResponse>>>()
    const frames: unknown[] = []
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
        if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve(message)
      }),
    ]
    const id = (name: string) => `${mode}-${name}`
    const send = (name: string, request: Record<string, unknown>) => {
      receipts.set(id(name), Promise.withResolvers<SDKControlResponse>())
      return JSON.stringify({type:'control_request',request_id:id(name),request})+'\n'
    }
    const wait = (name: string) => receipts.get(id(name))!.promise
    const values = new Map<string, SDKControlResponse['response']>()
    async function* input() {
      yield send('init', {subtype:'initialize'})
      values.set('init', (await wait('init')).response)
      // Exercise the advertised protocol through runHeadless, not a replacement handler.
      yield send('attach', {subtype:'ui_attach',surface:'desktop',client_id:'probe'})
      values.set('attach', (await wait('attach')).response)
      if (mode === 'available') {
        yield send('render', {subtype:'ui_render',surface:'desktop',component:'ToolUse',instance_id:'probe',client_id:'probe',props:{}})
        const render = (await wait('render')).response
        values.set('render', render)
        const tree = render.subtype === 'success' ? render.response?.tree as {press?:Record<string,unknown>} | undefined : undefined
        if (tree?.press) {
          yield send('press', {subtype:'ui_press',...tree.press})
          values.set('press', (await wait('press')).response)
        }
        yield send('detach', {subtype:'ui_detach',client_id:'probe'})
        values.set('detach', (await wait('detach')).response)
      }
      yield send('end', {subtype:'end_session'})
      values.set('end', (await wait('end')).response)
    }
    let state = getDefaultAppState()
    try {
      await runHeadless(input(), () => state, updater => {state=updater(state)}, [], [], {}, [], {
        outputFormat:'stream-json',verbose:true,sessionStartHooksPromise:Promise.resolve([]),modsSession:session,
      } as Parameters<typeof runHeadless>[7])
      const init = values.get('init')!
      expect(init.subtype).toBe('success')
      if (init.subtype !== 'success') throw new Error(init.error)
      // Advertise the protocol only when this connection can execute its UI controls.
      if (mode === 'available') {
        expect(init.response?.capabilities).toEqual(['ui_surface_v1'])
        expect(values.get('attach')).toEqual({subtype:'success',request_id:id('attach'),response:{surfaces:['desktop']}})
        // Official 2.1.292 native: element attributes are in tree.props; handles are connection-local.
        expect(values.get('render')).toEqual({subtype:'success',request_id:id('render'),response:{
          tree:{type:'Button',props:{key:'run',label:'Run'},press:{plugin:'capability-probe',handle:expect.any(Number)}},
          props:{tool_use_id:'probe'},rewritten:false,hooked:true,
        }})
        expect(values.get('press')).toEqual({subtype:'success',request_id:id('press'),response:{handled:true,element:'run'}})
        expect(frames).toContainEqual(expect.objectContaining({type:'system',subtype:'ui_log',plugin:'capability-probe',text:'CAPABILITY_PRESSED'}))
        expect(values.get('detach')).toEqual({subtype:'success',request_id:id('detach'),response:{detached:true,surfaces:[]}})
      } else {
        expect(init.response).not.toHaveProperty('capabilities')
        expect(values.get('attach')).toEqual({subtype:'error',request_id:id('attach'),error:'ui_attach: Mods session is unavailable'})
      }
      expect(frames).toContainEqual({type:'control_response',response:{subtype:'success',request_id:id('end'),response:undefined}})
    } finally {
      await session?.dispose()
      for (const mock of mocks) mock.mockRestore()
      rmSync(root, {recursive:true,force:true})
    }
  })
}
