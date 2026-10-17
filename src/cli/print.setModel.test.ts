import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_SET_MODEL_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('set_model validates before changing the real headless session (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-set-model-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_AUTO_COMPACT|CLAUDE_AUTOCOMPACT|DISABLE_COMPACT|DISABLE_AUTO_COMPACT)/.test(key)))
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
  }, 30_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const bootstrap = await import('../bootstrap/state.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')

  const sideQuery = await import('../utils/sideQuery.js')
  const { APIError, APIConnectionError } = await import('@anthropic-ai/sdk')
  const { SDKControlResponseSchema } = await import('../entrypoints/sdk/controlSchemas.js')

  test('official 292 validation receipts, cached success and unchanged model after failure', async () => {
    const frames: StdoutMessage[] = []
    const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const calls: import('../utils/sideQuery.js').SideQueryOptions[] = []
    const validationStarted = Promise.withResolvers<void>()
    const releaseValidation = Promise.withResolvers<void>()
    const snapshots: (string | undefined)[] = []
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const oldModel = bootstrap.getMainLoopModelOverride()
    const expected: import('../entrypoints/sdk/controlTypes.js').SDKControlResponse['response'][] = [
      {subtype:'success',request_id:'0'},
      {subtype:'success',request_id:'1'},
      {subtype:'error',request_id:'2',error:'Authentication failed. Please check your API credentials.',error_code:'auth_failed'},
      {subtype:'error',request_id:'3',error:"Model 'owned-missing' not found",error_code:'catalog_unknown'},
      {subtype:'error',request_id:'4',error:'API error: 403 owned validation failure · model not changed'},
      {subtype:'error',request_id:'5',error:'API error: 500 owned validation failure · model not changed',error_code:'check_failed'},
      {subtype:'error',request_id:'6',error:'API error: 400 owned validation failure · model not changed'},
      {subtype:'error',request_id:'7',error:'Network error. Please check your internet connection.',error_code:'check_failed'},
      {subtype:'success',request_id:'8'},
      {subtype:'error',request_id:'9',error:'Model "(unrecognized model name)" is not a recognized model id. Run /model to see available models.',error_code:'catalog_unknown'},
    ]
    const models = ['owned-good','owned-good','owned-auth','owned-missing','owned-denied','owned-server','owned-bad','owned-network','sonnet','']
    const mocks = [
      spyOn(grove,'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook,'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env,'isBareMode').mockReturnValue(true),
      spyOn(shutdown,'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils,'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard,'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings,'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool,'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager,'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager,'isSandboxingEnabled').mockReturnValue(false),
      spyOn(sideQuery,'sideQuery').mockImplementation(async options => {
        calls.push(options)
        if (options.model === 'owned-auth') {
          validationStarted.resolve()
          await releaseValidation.promise
        }
        if (options.model === 'owned-network') throw new APIConnectionError({message:'owned transport failure'})
        const status = {'owned-auth':401,'owned-missing':404,'owned-denied':403,'owned-server':500,'owned-bad':400}[options.model]
        if (status) throw APIError.generate(status,{type:'error',error:{type:status===404?'not_found_error':'api_error',message:'owned validation failure'}},undefined,new Headers())
        return {content:[{type:'text',text:'ok'}]} as Awaited<ReturnType<typeof sideQuery.sideQuery>>
      }),
      spyOn(StructuredIO.prototype,'write').mockImplementation(async message => {
        frames.push(message)
        if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve()
      }),
    ]
    async function* input() {
      for (const [i,model] of models.entries()) {
        const id=String(i);receipts.set(id,Promise.withResolvers<void>())
        yield JSON.stringify({type:'control_request',request_id:id,request:{subtype:'set_model',model}})+'\n'
        if (i === 2) {
          await validationStarted.promise
          receipts.set('interrupt', Promise.withResolvers<void>())
          yield JSON.stringify({type:'control_request',request_id:'interrupt',request:{subtype:'interrupt'}})+'\n'
          await receipts.get('interrupt')!.promise
          releaseValidation.resolve()
        }
        await receipts.get(id)!.promise
        snapshots.push(bootstrap.getMainLoopModelOverride())
      }
    }
    try {
      await runHeadless(input(),store.getState,store.setState,[],[],{},[],{
        outputFormat:'stream-json',verbose:true,userSpecifiedModel:'claude-sonnet-4-6',sessionStartHooksPromise:Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      // Official 2.1.292: real stdio controls against a controlled HTTP endpoint.
      expect(frames.filter(m=>m.type==='control_response').filter(m=>m.response.request_id!=='interrupt').map(m=>JSON.parse(JSON.stringify(m.response)))).toEqual(expected)
      expect(frames.filter(m=>m.type==='control_response').map(m=>m.response.request_id)).toEqual(['0','1','interrupt','2','3','4','5','6','7','8','9'])
      expect(snapshots).toEqual([...Array(8).fill('owned-good'),'sonnet','sonnet'])
      expect(calls.map(call=>call.model)).toEqual(['owned-good','owned-auth','owned-missing','owned-denied','owned-server','owned-bad','owned-network'])
      for (const call of calls) expect(call).toMatchObject({max_tokens:1,maxRetries:0,querySource:'model_validation'})
      for (const response of expected) expect(SDKControlResponseSchema().parse({type:'control_response',response})).toEqual({type:'control_response',response})
    } finally {
      releaseValidation.resolve()
      bootstrap.setMainLoopModelOverride(oldModel)
      for (const mock of mocks) mock.mockRestore()
    }
  })
  test('a user message immediately after set_model uses the validated model and its default effort', async () => {
    const engine = await import('../QueryEngine.js')
    const { resolveAppliedEffort } = await import('../utils/effort.js')
    const { createAssistantMessage } = await import('../utils/messages.js')
    const store = createStore(getDefaultAppState(), onChangeAppState)
    const oldModel = bootstrap.getMainLoopModelOverride()
    const requested = 'claude-opus-5-5'
    const calls: { model: string | undefined; effort: unknown }[] = []
    const frames: StdoutMessage[] = []
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
      spyOn(sideQuery, 'sideQuery').mockImplementation(async options => {
        expect(options).toMatchObject({model: requested, max_tokens: 1, querySource: 'model_validation'})
        // Model validation is deliberately slower than stdin delivery, as in the native regression.
        await new Promise<void>(resolve => setTimeout(resolve, 1500))
        return {content: [{type: 'text', text: 'ok'}]} as Awaited<ReturnType<typeof sideQuery.sideQuery>>
      }),
      spyOn(engine, 'ask').mockImplementation(async function* (options) {
        calls.push({model: options.userSpecifiedModel,
          effort: resolveAppliedEffort(options.userSpecifiedModel!, options.getAppState().effortValue)})
        const assistant = createAssistantMessage({content: 'done'})
        yield {type: 'assistant', message: assistant.message, parent_tool_use_id: null,
          session_id: bootstrap.getSessionId(), uuid: assistant.uuid}
      }),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => { frames.push(message) }),
    ]
    async function* input() {
      yield JSON.stringify({type: 'control_request', request_id: 'ordered-model',
        request: {subtype: 'set_model', model: requested}}) + '\n'
      yield JSON.stringify({type: 'user', message: {role: 'user', content: 'after model change'}}) + '\n'
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, userSpecifiedModel: 'claude-sonnet-4-6',
        sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
      expect(calls).toEqual([{model: requested, effort: 'medium'}])
      expect(frames.filter(frame => frame.type === 'control_response').map(frame => frame.response))
        .toEqual([{subtype: 'success', request_id: 'ordered-model'}])
    } finally {
      bootstrap.setMainLoopModelOverride(oldModel)
      for (const mock of mocks) mock.mockRestore()
    }
  })
  test('validation deadline aborts the probe and a late answer cannot enter the success cache', async () => {
    const { validateModel } = await import('../utils/model/validateModel.js')
    const probe = Promise.withResolvers<Awaited<ReturnType<typeof sideQuery.sideQuery>>>()
    let expire: (() => void) | undefined
    let signal: AbortSignal | undefined
    let calls = 0
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      expect(ms).toBe(5000)
      expire = () => callback(...args)
      return 1
    }) as typeof setTimeout)
    const query = spyOn(sideQuery, 'sideQuery').mockImplementation(options => {
      calls++;signal=options.signal
      return calls===1 ? probe.promise : Promise.resolve({content:[]} as Awaited<ReturnType<typeof sideQuery.sideQuery>>)
    })
    try {
      const pending = validateModel('owned-slow', {deadlineMs:5000})
      expect(expire).toBeFunction()
      expire!()
      expect(await pending).toEqual({valid:false,error:'Couldn\'t confirm model "owned-slow" with the API. Try again, or run /model to see available models.',errorCode:'check_failed'})
      expect(signal?.aborted).toBe(true)
      probe.resolve({content:[]} as Awaited<ReturnType<typeof sideQuery.sideQuery>>)
      await probe.promise
      expect(await validateModel('owned-slow')).toEqual({valid:true})
      expect(calls).toBe(2)
    } finally {
      query.mockRestore();timer.mockRestore()
      probe.resolve({content:[]} as Awaited<ReturnType<typeof sideQuery.sideQuery>>)
    }
  })

}
