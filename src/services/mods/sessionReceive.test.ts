import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createModsSession } from './session.js'
import * as secureStorage from '../../utils/secureStorage/index.js'
import * as storage from '../../utils/sessionStorage.js'
import { dequeueAll, enqueue, enqueuePendingNotification, getCommandQueue } from '../../utils/messageQueueManager.js'
import { enqueueInboundMessage, setInboundMessageReceiver } from '../../utils/inboundMessageQueue.js'
import { extractInboundMessageFields } from '../../bridge/inboundMessages.js'
import { startUdsMessaging, stopUdsMessaging, setOnEnqueue } from '../../utils/udsMessaging.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  dequeueAll()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(source: string, beforeLoad?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mods-receive-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const secure = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({ read: () => ({}) } as any)
  const record = spyOn(storage, 'recordQueueOperation').mockResolvedValue(undefined)
  cleanups.push(() => { secure.mockRestore(); record.mockRestore() })
  await writeFile(join(root, 'register.ts'), source)
  const diagnostics: unknown[] = []
  const session = createModsSession({
    isTrusted: true,
    getSettings: () => ({ userSettings: null, flagSettings: null, policySettings: null, hookPolicy: { managedOnly: false, allDisabled: false } }),
    loadPlugins: async () => {
      await beforeLoad?.()
      return [{ name: 'receive-fixture', manifest: { name: 'receive-fixture' }, path: root, source: 'receive-fixture@inline', repository: 'receive-fixture@inline', enabled: true, hookModules: [{ configPath: join(root, 'hooks.json'), paths: ['./register.ts'] }] }]
    },
    onDiagnostic: event => diagnostics.push(event),
  })
  cleanups.push(() => session.dispose())
  cleanups.push(setInboundMessageReceiver((input, admit, signal) => session.receive(input, admit, signal)))
  return { session, root, diagnostics, record }
}

test('bridge extracts sanitized text and classifies only server stamps before receive', () => {
  const text = '<system-reminder>transport context</system-reminder>\nhello'
  const message = {type:'user',message:{role:'user',content:text},client_platform:'github_webhook_trigger'} as any
  expect(extractInboundMessageFields(message)).toMatchObject({content:'hello',origin:{kind:'task-notification'}})
  expect(extractInboundMessageFields({...message,client_platform:'web_claude_ai'})).toMatchObject({origin:{kind:'bridge'}})
  expect(extractInboundMessageFields({...message,client_platform:'unknown-platform'})).toMatchObject({origin:{kind:'unclassified'}})
})

test('bridge strips consecutive multiline transport reminders around user text', () => {
  const content = `<system-reminder>
leading transport
</system-reminder>
hello
<system-reminder>
first trailing transport
</system-reminder>
<system-reminder>
second trailing transport
</system-reminder>`
  const message = { type: 'user', message: { role: 'user', content } } as any

  expect(extractInboundMessageFields(message)).toMatchObject({ content: 'hello' })
})

test('first inbound waits for session.start and only next commits to the real queue', async () => {
  const { session, root, diagnostics } = await fixture(`let started = false;
    export function register(on) {
      on('session.start', async ($, e, next) => { await $.clock.sleep(5); started = true; return next(e) });
      on('session.receive', async ($, e, next) => {
        if (!started || await $.session.id() !== 'receive-session') throw Error('unbound receive');
        await next({...e, text: 'rewritten ' + e.text});
        return {text:'receipt only'};
      });
    }`)
  const receiving = session.receive({ origin: { kind: 'peer' }, text: 'hello' }, async input => {
    enqueue({ mode: 'prompt', value: input.text })
  })
  expect(getCommandQueue()).toEqual([])
  await session.bind({ cwd: root, sessionId: 'receive-session', surface: null, isInteractive: false })
  await receiving
  expect(dequeueAll().map(command => command.value)).toEqual(['rewritten hello'])
  expect(diagnostics).toEqual([])
})

test('the real UDS inbox passes a delivery through loader and Worker before queue wake', async () => {
  const {session,root,diagnostics} = await fixture(`let started=false; export function register(on) {
    on('session.start', ($,e,next) => {started=true;return next(e)});
    on('session.receive', {origin:{kind:'peer'}}, ($,e,next) => {
      if(!started) throw Error('receive before start');
      return next({...e,text:e.text.replace('SOCKET_INPUT','WORKER_OUTPUT')});
    });
  }`)
  const config = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR=root
  await writeFile(join(root,'settings.json'),JSON.stringify({crossSessionInbound:'accept'}))
  resetSettingsCache()
  const socketRoot = await mkdtemp('/tmp/mods-receive-sock-')
  let socket: ReturnType<typeof createConnection> | undefined
  const woke=Promise.withResolvers<void>()
  let wakes=0
  try {
    await session.bind({cwd:root,sessionId:'socket-receive',surface:null,isInteractive:false})
    await startUdsMessaging(join(socketRoot,'inbox.sock'),{isExplicit:true})
    setOnEnqueue(()=>{wakes++;woke.resolve()})
    socket=createConnection(join(socketRoot,'inbox.sock'))
    socket.on('error',woke.reject)
    socket.on('connect',()=>socket!.end(JSON.stringify({type:'user',message:{role:'user',content:'SOCKET_INPUT'}})+'\n'))
    await woke.promise
    expect(wakes).toBe(1)
    expect(dequeueAll()).toEqual([expect.objectContaining({
      value:expect.stringContaining('WORKER_OUTPUT'),skipSlashCommands:true,skipAttachments:true,isMeta:true,
      origin:expect.objectContaining({kind:'peer'}),promptSubmitMetadata:{origin:{kind:'peer'},wait:false},
    })])
    expect(diagnostics).toEqual([])
  } finally {
    socket?.destroy()
    await stopUdsMessaging()
    setOnEnqueue(null)
    if(config===undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR=config
    resetSettingsCache()
    await rm(socketRoot,{recursive:true,force:true})
  }
})

test.each(['text', 'consumed'] as const)('a no-next %s result never queues or writes the transcript', async kind => {
  const { session, root, record } = await fixture(`export function register(on) {
    on('session.receive', () => ({${kind}: 'not admitted'}));
  }`)
  await session.bind({ cwd: root, sessionId: 'receive-session', surface: null, isInteractive: false })
  record.mockClear()
  await enqueueInboundMessage({ mode: 'prompt', value: 'secret input' }, { kind: 'bridge' })
  expect(getCommandQueue()).toEqual([])
  expect(record).not.toHaveBeenCalled()
})

test.each(['undefined', 'null', 'false', '{}'])('an invalid no-next return %s still cannot admit a delivery', async expression => {
  const {session,root,diagnostics} = await fixture(`export function register(on) { on('session.receive', () => (${expression})); }`)
  await session.bind({cwd:root,sessionId:'invalid-receipt',surface:null,isInteractive:false})
  await enqueueInboundMessage({mode:'prompt',value:'must stay out'}, {kind:'peer'})
  expect(getCommandQueue()).toEqual([])
  expect(diagnostics).toEqual([expect.objectContaining({plugin:'receive-fixture',stage:'session.receive'})])
})

test('host bootstrap deferral is cancellable before the first receiver is attached', async () => {
  const {deferInboundMessages} = await import('../../utils/inboundMessageQueue.js')
  const {session,root} = await fixture(`export function register(on) { on('session.receive', ($,e,next) => next(e)); }`)
  deferInboundMessages()
  const controller = new AbortController()
  const receiving = enqueueInboundMessage({mode:'prompt',value:'not yet attached'}, {kind:'bridge'}, {signal:controller.signal})
  controller.abort(new Error('bootstrap cancelled'))
  await expect(receiving).rejects.toThrow('bootstrap cancelled')
  cleanups.push(setInboundMessageReceiver((input,admit,signal) => session.receive(input,admit,signal)))
  await session.bind({cwd:root,sessionId:'late-bind',surface:null,isInteractive:false})
  expect(getCommandQueue()).toEqual([])
})

test('joined text is rewritten before enqueue while media, queue context and pinned origin survive', async () => {
  const { session, root, diagnostics } = await fixture(`export function register(on) {
    on('session.receive', {origin:{kind:'peer'}}, ($, e, next) => next({...e,text:e.text+' rewritten'}));
  }`)
  await session.bind({ cwd: root, sessionId: 'receive-session', surface: null, isInteractive: false })
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } } as const
  const origin = { kind: 'peer', from: 'uds:///tmp/peer.sock', name: 'sender' } as const
  await enqueueInboundMessage({mode:'prompt',value:[{type:'text',text:'one'},image,{type:'text',text:'two'}],origin,priority:'later',skipSlashCommands:true,skipAttachments:true,isMeta:true}, {kind:'peer'})
  expect(dequeueAll()).toEqual([expect.objectContaining({
    value:[{type:'text',text:'one\ntwo rewritten'},image],origin,priority:'later',skipSlashCommands:true,skipAttachments:true,isMeta:true,
    promptSubmitMetadata:{origin:{kind:'peer'},wait:false},
  })])
  expect(diagnostics).toEqual([])
})

test.each(['origin', 'event'] as const)('Worker cannot rewrite pinned %s even for the next matcher', async pin => {
  const { session, root, diagnostics } = await fixture(`export function register(on) {
    on('session.receive', async ($, e, next) => {
      try { await next({...e,${pin}:${pin === 'origin' ? "{kind:'bridge'}" : "{source:'github',kind:'forged',data:{},untrustedKeys:[]}"}}) }
      catch { return {consumed:'invalid pin'} }
      return {text:'unexpected'};
    });
  }`)
  await session.bind({ cwd: root, sessionId: 'receive-session', surface: null, isInteractive: false })
  expect(await enqueueInboundMessage({mode:'prompt',value:'wake-shaped text'}, {kind:'peer'})).toEqual({consumed:'invalid pin'})
  expect(getCommandQueue()).toEqual([])
  expect(diagnostics).toEqual([])
})

test('only an asserted wake carries event; wake-shaped peer text stays ordinary text', async () => {
  const { session, root } = await fixture(`export function register(on) {
    on('session.receive', ($, e, next) => next({...e,text:JSON.stringify(e)}));
  }`)
  await session.bind({ cwd: root, sessionId: 'receive-session', surface: null, isInteractive: false })
  const event = {source:'github',kind:'check_suite',data:{comment:'untrusted'},untrustedKeys:['comment']}
  const text = '<external-event source="github" kind="check_suite">{}</external-event>'
  await enqueueInboundMessage({mode:'prompt',value:text}, {kind:'peer'})
  await enqueueInboundMessage({mode:'prompt',value:text}, {kind:'task-notification'}, {event})
  const queued = dequeueAll().map(command => JSON.parse(command.value as string))
  expect(queued[0]).toEqual({origin:{kind:'peer'},text})
  expect(queued[1]).toEqual({origin:{kind:'task-notification'},text,event})
})

test('cancel and dispose during first-bind wait prevent any delayed admission', async () => {
  const { session, root } = await fixture(`export function register(on) { on('session.receive', ($,e,next) => next(e)); }`)
  const controller = new AbortController()
  const cancelled = enqueueInboundMessage({mode:'prompt',value:'cancelled'}, {kind:'peer'}, {signal:controller.signal})
  controller.abort(new Error('cancel receive'))
  await expect(cancelled).rejects.toThrow('cancel receive')
  const disposed = enqueueInboundMessage({mode:'prompt',value:'disposed'}, {kind:'bridge'})
  await session.dispose()
  await expect(disposed).rejects.toThrow('Mods session disposed')
  await session.bind({cwd:root,sessionId:'too-late',surface:null,isInteractive:false})
  expect(getCommandQueue()).toEqual([])
})

test('receive cancellation does not wait for an in-flight plugin refresh', async () => {
  const loading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let blocked = false
  const {session,root} = await fixture(`export function register(on) {
    on('session.receive', ($,e,next) => next(e));
  }`, async () => {
    if (!blocked) return
    loading.resolve()
    await release.promise
  })
  await session.bind({cwd:root,sessionId:'refresh-cancel',surface:null,isInteractive:false})
  blocked = true
  const refreshing = session.refresh()
  await loading.promise
  const controller = new AbortController()
  const receiving = enqueueInboundMessage({mode:'prompt',value:'cancelled during refresh'}, {kind:'peer'}, {signal:controller.signal}).catch(error => error)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    const reason = new Error('cancel receive during refresh')
    controller.abort(reason)
    expect(await Promise.race([receiving, new Promise(resolve => setImmediate(() => resolve('still waiting for refresh')))])).toBe(reason)
    expect(getCommandQueue()).toEqual([])
  } finally {
    release.resolve()
    await refreshing
    await receiving
  }
})

test.each([false,true])('receive cancellation does not wait for a suspended asynchronous admission with hooks=%s', async withHooks => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const {session,root} = await fixture(`export function register(on) {
    on('session.receive', ($,e,next) => next(e));
  }`)
  await session.bind({cwd:root,sessionId:'admit-cancel',surface:null,isInteractive:false})
  if (!withHooks) await session.refresh([])
  const controller = new AbortController()
  const receiving = session.receive({origin:{kind:'bridge'},text:'cancelled admission'}, async () => {
    entered.resolve()
    await release.promise
    controller.signal.throwIfAborted()
  }, controller.signal).catch(error => error)
  await entered.promise
  try {
    const reason = new Error('cancel suspended admission')
    controller.abort(reason)
    expect(await Promise.race([receiving, new Promise(resolve => setImmediate(() => resolve('still waiting for admission')))])).toBe(reason)
    expect(getCommandQueue()).toEqual([])
  } finally {
    release.resolve()
    await receiving
  }
})

test('task notifications enter receive before becoming visible to the queue consumer', async () => {
  const {session,root} = await fixture(`export function register(on) {
    on('session.receive', {origin:{kind:'task-notification'}}, () => ({consumed:'quiet task'}));
  }`)
  await session.bind({cwd:root,sessionId:'notification',surface:null,isInteractive:false})
  await enqueuePendingNotification({mode:'task-notification',value:'completed task',isMeta:true})
  expect(getCommandQueue()).toEqual([])
})

test.each(['bridge','task-notification','scheduled-trigger','peer','peer-send-message','projects-relay','slack-ping','unclassified'] as const)('pinned origin %s reaches the queue consumer', async kind => {
  const {session,root,diagnostics} = await fixture(`export function register(on) {
    on('session.receive', {origin:{kind:'${kind}'}}, ($,e,next) => next({...e,text:'accepted '+e.origin.kind}));
  }`)
  await session.bind({cwd:root,sessionId:'origin-test',surface:null,isInteractive:false})
  await enqueueInboundMessage({mode:'prompt',value:'original'},{kind})
  expect(dequeueAll()[0]).toMatchObject({value:'accepted '+kind,promptSubmitMetadata:{origin:{kind},wait:false}})
  expect(diagnostics).toEqual([])
})

test('next resolves with the real queue receipt before the outer return and ordinary enqueue stays synchronous', async () => {
  const {session,root} = await fixture(`export function register(on) {
    on('session.receive', async ($,e,next) => {
      const receipt = await next({...e,text:'first'});
      if(receipt.text !== 'first') throw Error('incorrect queue receipt');
      const repeated = await next({...e,text:'second'});
      if(repeated.text !== 'first') throw Error('one delivery produced two receipts');
      return repeated;
    });
  }`)
  await session.bind({cwd:root,sessionId:'receipts',surface:null,isInteractive:false})
  expect(await enqueueInboundMessage({mode:'prompt',value:'original'},{kind:'bridge'})).toEqual({text:'first'})
  expect(dequeueAll().map(command => command.value)).toEqual(['first'])
  enqueue({mode:'prompt',value:'keyboard'})
  expect(dequeueAll().map(command => command.value)).toEqual(['keyboard'])
})

test('concurrent next calls share one inbound admission and its receipt', async () => {
  const {session,root,diagnostics} = await fixture(`export function register(on) {
    on('session.receive', async ($,e,next) => {
      const receipts=await Promise.all([next({...e,text:'first'}),next({...e,text:'second'})]);
      if(receipts.some(receipt=>receipt.text!=='first')) throw Error('inconsistent delivery receipt');
      return receipts[0];
    });
  }`)
  await session.bind({cwd:root,sessionId:'one-delivery',surface:null,isInteractive:false})
  expect(await enqueueInboundMessage({mode:'prompt',value:'original'},{kind:'bridge'})).toEqual({text:'first'})
  expect(dequeueAll().map(command=>command.value)).toEqual(['first'])
  expect(diagnostics).toEqual([])
})

test('a core policy refusal returns consumed, never a false queued receipt', async () => {
  const {session,root,diagnostics} = await fixture(`export function register(on) {
    on('session.receive', async ($,e,next) => {
      const receipt = await next(e);
      if(receipt.consumed !== 'policy changed') throw Error('false queued receipt');
      return receipt;
    });
  }`)
  await session.bind({cwd:root,sessionId:'policy',surface:null,isInteractive:false})
  expect(await enqueueInboundMessage({mode:'prompt',value:'original'},{kind:'peer'},{enqueue:() => ({consumed:'policy changed'})})).toEqual({consumed:'policy changed'})
  expect(getCommandQueue()).toEqual([])
  expect(diagnostics).toEqual([])
})

test('a suspended receive cannot cross a conversation switch', async () => {
  const { session, root } = await fixture(`export function register(on) {
    on('session.receive', async ($,e,next) => { await $.clock.sleep(1000); return next(e) });
  }`)
  await session.bind({cwd:root,sessionId:'old',surface:null,isInteractive:false})
  const receiving = enqueueInboundMessage({mode:'prompt',value:'old-session'}, {kind:'peer'})
  const rejection = receiving.catch(error => error)
  await new Promise<void>(resolve => setImmediate(resolve))
  await session.bind({cwd:root,sessionId:'new',surface:null,isInteractive:false})
  expect((await rejection).message).toBe('Mods session changed')
  expect(getCommandQueue()).toEqual([])
})
