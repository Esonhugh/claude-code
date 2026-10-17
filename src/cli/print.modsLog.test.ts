import {expect, spyOn, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const childFlag = 'CLAUDE_CODE_PRINT_LOG_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('headless Mods log delivery (isolated)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'print-mods-log-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: {
          PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root,
          TMPDIR: root, [childFlag]: '1', ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      const summary = `${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)
      if (summary) console.log(summary[0])
    } finally { rmSync(root, {recursive: true, force: true}) }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & {MACRO: {VERSION: string}}).MACRO = {VERSION: 'test'}
  const {runHeadless} = await import('./print.js')
  const {StructuredIO} = await import('./structuredIO.js')
  const engine = await import('../QueryEngine.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const tools = await import('../tools.js')
  const storage = await import('../utils/sessionStorage.js')
  const debug = await import('../utils/debug.js')
  const {SandboxManager} = await import('../utils/sandbox/sandbox-adapter.js')
  const {getDefaultAppState} = await import('../state/AppStateStore.js')
  const {createModsSession} = await import('../services/mods/session.js')
  const {dequeueAllMatching} = await import('../utils/messageQueueManager.js')

  for (const format of ['text', 'json', 'stream-json'] as const) {
    test(`${format}: Worker logs use the selected output sink without entering model history`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'print-log-plugin-'))
      const loaded = ['log-policy', 'headless-logger'].map((name, index) => {
        const path = join(root, name)
        mkdirSync(path)
        writeFileSync(join(path, 'register.ts'), index === 0 ? `export function register(on) {
          on('ui.log', {text:'LOG-REWRITE'}, ($,e,next) => next({...e,to:'debug'}));
        }` : `export function register(on) {
          on('session.start', ($,e,next) => {
            $.ui.log('LOG-START'); $.ui.log('LOG-START-DEBUG',{to:'debug'}); return next(e);
          });
          on('command.run', async($,e) => {
            const result=$.ui.log('LOG-LIVE');
            $.ui.log('LOG-DEBUG',{to:'debug'}); $.ui.log('LOG-REWRITE');
            $.ui.log('LOG-LONG-'+'a'.repeat(9990)+'😀tail',{to:'debug'});
            $.ui.log('LOG-INVALID',{to:'invalid'});
            return {text:JSON.stringify({returnsVoid:result===undefined})};
          });
        }`)
        return {name,manifest:{name},path,source:name+'@inline',repository:name+'@inline',enabled:true,
          hookModules:[{configPath:join(path,'hooks.json'),paths:['./register.ts']}]}
      })
      const mods = createModsSession({isTrusted:true,
        getSettings:() => ({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),
        loadPlugins:async () => loaded,
      })
      let state = getDefaultAppState()
      const logs: string[] = [], writes: unknown[] = []
      let calls = 0
      const mocks = [
        spyOn(debug,'logForDebugging').mockImplementation(text => {logs.push(text)}),
        spyOn(grove,'isQualifiedForGrove').mockResolvedValue(false),
        spyOn(growthbook,'initializeGrowthBook').mockResolvedValue(undefined),
        spyOn(env,'isBareMode').mockReturnValue(true),
        spyOn(shutdown,'gracefulShutdownSync').mockImplementation(() => {}),
        spyOn(processUtils,'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
        spyOn(processUtils,'writeToStdout').mockImplementation(text => {writes.push(text)}),
        spyOn(stdoutGuard,'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
        spyOn(modelStrings,'ensureModelStringsInitialized').mockResolvedValue(undefined),
        spyOn(tools,'assembleToolPool').mockReturnValue([]),
        spyOn(SandboxManager,'getSandboxUnavailableReason').mockReturnValue(undefined),
        spyOn(SandboxManager,'isSandboxingEnabled').mockReturnValue(false),
        spyOn(storage,'recordQueueOperation').mockResolvedValue(undefined),
        spyOn(StructuredIO.prototype,'write').mockImplementation(async message => {writes.push(message)}),
        spyOn(engine,'ask').mockImplementation(async function*(args) {
          calls++
          await mods.refresh()
          const before = [...args.mutableMessages]
          expect(await mods.runtime!.dispatch('command.run',{command:'probe'},async () => ({text:'unhandled'})))
            .toEqual({text:'{"returnsVoid":true}'})
          await mods.runtime!.settle()
          expect(args.mutableMessages).toEqual(before)
          yield {type:'result',subtype:'success',is_error:false,result:'MODEL-DONE'} as import('../entrypoints/agentSdkTypes.js').SDKMessage
        }),
      ]
      try {
        await runHeadless('probe',() => state,update => {state=update(state)},[],[],{},[],{
          outputFormat:format,verbose:true,modsSession:mods,sessionStartHooksPromise:Promise.resolve([]),
        } as Parameters<typeof runHeadless>[7])
        expect(calls).toBe(1)
        const delivered = logs.filter(line => line.startsWith('[headless-logger] $.ui.log'))
        expect(delivered.slice(0,2)).toEqual([
          '[headless-logger] $.ui.log: LOG-START',
          '[headless-logger] $.ui.log (to debug): LOG-START-DEBUG',
        ])
        // Void notifications can finish out of order when middleware awaits next.
        expect([...delivered].sort()).toEqual([
          '[headless-logger] $.ui.log: LOG-START',
          '[headless-logger] $.ui.log (to debug): LOG-START-DEBUG',
          '[headless-logger] $.ui.log: LOG-LIVE',
          '[headless-logger] $.ui.log (to debug): LOG-DEBUG',
          '[headless-logger] $.ui.log (to debug): LOG-REWRITE',
          '[headless-logger] $.ui.log (to debug): LOG-LONG-'+'a'.repeat(9990)+'…',
        ].sort())
        expect(logs).toContainEqual(expect.stringContaining('$.ui.log dropped: ui.log to must be transcript or debug'))
        expect(logs.some(line => line.includes('UI log is unavailable'))).toBe(false)
        const uiLogs = writes.filter((message: any) => message.type === 'system' && message.subtype === 'ui_log')
        if (format === 'stream-json') {
          expect(uiLogs).toEqual(['LOG-START','LOG-LIVE'].map(text => ({
            type:'system',subtype:'ui_log',plugin:'headless-logger',text,
            uuid:expect.any(String),session_id:expect.any(String),
          })))
          expect(new Set(uiLogs.map((message: any) => message.uuid)).size).toBe(2)
        } else expect(uiLogs).toEqual([])
        expect(JSON.stringify(writes.filter(message => !uiLogs.includes(message)))).not.toContain('LOG-')
        expect(JSON.stringify(writes)).toContain('MODEL-DONE')
      } finally {
        await mods.dispose()
        dequeueAllMatching(() => true)
        for (const mock of mocks) mock.mockRestore()
        rmSync(root,{recursive:true,force:true})
      }
    })
  }
}
