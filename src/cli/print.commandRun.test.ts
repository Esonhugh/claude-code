import {expect, spyOn, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {SDKMessage} from '../entrypoints/agentSdkTypes.js'
import type {CommandRunResult} from '../services/mods/commandAdapter.js'

const childFlag = 'CLAUDE_CODE_PRINT_COMMAND_RUN_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('headless sequential Mods commands (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'print-command-run-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: {PATH:process.env.PATH, HOME:home, CLAUDE_CONFIG_DIR:home, TMPDIR:home,
          [childFlag]:'1', ANTHROPIC_API_KEY:'test-only-not-a-real-key', DISABLE_TELEMETRY:'1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'},
        stdout:'pipe', stderr:'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      const summary = `${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)
      if (summary) console.log(summary[0])
    } finally { rmSync(home, {recursive:true, force:true}) }
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & {MACRO:{VERSION:string}}).MACRO = {VERSION:'test'}
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
  const {SandboxManager} = await import('../utils/sandbox/sandbox-adapter.js')
  const {getDefaultAppState} = await import('../state/AppStateStore.js')
  const {createModsSession} = await import('../services/mods/session.js')
  const {createModCommandQueue} = await import('../services/mods/commandRunQueue.js')
  const {dequeueAllMatching} = await import('../utils/messageQueueManager.js')

  test('closed input still drains commands queued by a completion hook after the previous receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'print-sequential-plugin-'))
    writeFileSync(join(root, 'register.ts'), `export function register(on) {
      on('session.start', async($,e,next) => {
        await $.command.register({name:'hello',description:'fixture'}); return next(e);
      });
      on('command.run', {command:'hello'}, ($,e) => ({text:e.args+' result'}));
      on('turn.complete', async($,e,next) => {
        const receipts=[await $.command.run({command:'hello',args:'first'})];
        await $.fs.read('next-command');
        for (const args of ['second','third']) receipts.push(await $.command.run({command:'hello',args}));
        await $.fs.write(${JSON.stringify(join(root,'receipts.json'))},JSON.stringify(receipts)); return next(e);
      });
    }`)
    const mods = createModsSession({isTrusted:true,
      getSettings:() => ({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),
      loadPlugins:async () => [{name:'sequential',manifest:{name:'sequential'},path:root,
        source:'sequential@inline',repository:'sequential@inline',enabled:true,
        hookModules:[{configPath:join(root,'hooks.json'),paths:['./register.ts']}]}],
    })
    let state = getDefaultAppState()
    const gate = Promise.withResolvers<{value:string}>()
    const commands: string[] = []
    let calls = 0
    const mocks = [
      spyOn(grove,'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook,'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env,'isBareMode').mockReturnValue(true),
      spyOn(shutdown,'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils,'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(processUtils,'writeToStdout').mockImplementation(() => {}),
      spyOn(stdoutGuard,'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings,'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(tools,'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager,'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager,'isSandboxingEnabled').mockReturnValue(false),
      spyOn(storage,'recordQueueOperation').mockResolvedValue(undefined),
      spyOn(StructuredIO.prototype,'write').mockResolvedValue(undefined),
      spyOn(engine,'ask').mockImplementation(async function*(args) {
        if (calls++ === 0) {
          await mods.refresh()
          const runtime = mods.runtime!
          runtime.registerHostCallback({tier:'user',registration:{id:999,event:'fs.read',matcher:{},hasCatch:false}},
            (_$,input,next) => String(input.path).endsWith('next-command') ? gate.promise : next(input))
          const settle = runtime.settleTurns
          mocks.push(spyOn(runtime,'settleTurns').mockImplementation(() => {
            // Release only after the host has drained the queue and begun waiting for completion.
            gate.resolve({value:'released'})
            return settle()
          }))
          runtime.beginPublicTurn('sequential-turn')
          const turn = runtime.currentTurn()!
          // QueryEngine owns this queue and does not supply the print host's direct wake callback.
          turn.rememberQueryServices({commandRun:createModCommandQueue({owner:Symbol('engine')})})
          expect(await turn.finish({aborted:false,failed:false})).toBeUndefined()
        } else {
          const match = /^\/hello (first|second|third)$/.exec(String(args.prompt))!
          commands.push(match[1]!)
          const result = await mods.runtime!.dispatch('command.run', {
            command:'hello',args:match[1],origin:{kind:'plugin',name:'sequential'},
            presentation:{isFullscreen:false,columns:80},
          }, async () => {throw new Error('command was not handled')}) as CommandRunResult
          args.onPromptAdmission?.({messages:[],shouldQuery:false,allowedTools:[],resultText:result.text})
        }
        yield {type:'result',subtype:'success',is_error:false,result:'done'} as SDKMessage
      }),
    ]
    try {
      await runHeadless('start', () => state, update => {state=update(state)}, [], [], {}, [], {
        outputFormat:'stream-json',verbose:true,modsSession:mods,sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(commands).toEqual(['first','second','third'])
      // Official 2.1.292 native: all three author receipts settle with one model request and exit 0.
      expect(await Bun.file(join(root,'receipts.json')).json()).toEqual([
        {text:'first result'},{text:'second result'},{text:'third result'},
      ])
    } finally {
      gate.resolve({value:'released'})
      await mods.dispose()
      dequeueAllMatching(() => true)
      for (const mock of mocks) mock.mockRestore()
      rmSync(root,{recursive:true,force:true})
    }
  })
}
