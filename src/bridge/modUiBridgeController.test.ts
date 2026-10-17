import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModUiBridgeController } from './modUiBridgeController.js'
import { createModsRuntime } from '../services/mods/runtime.js'
import type { ModsSession } from '../services/mods/session.js'
import type { ReplBridgeHandle } from './replBridge.js'
import type { ModUiOutboundEvent } from './modUiMessages.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime>
const statuses: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridge-mod-ui-'))
  statuses.length = 0
  runtime = createModsRuntime({ services: { uiStatus: (_plugin, text) => { statuses.push(text) } } })
  await runtime.bind({ cwd: root, surface: 'desktop', isInteractive: true, sessionId: 'bridge-ui' })
})
afterEach(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })

function handle(events: ModUiOutboundEvent[]): ReplBridgeHandle {
  return {
    bridgeSessionId: 'session', environmentId: '', sessionIngressUrl: '',
    writeMessages() {}, writeSdkMessages() {}, sendModUiEvent: event => { events.push(event) },
    sendControlRequest() {}, sendControlResponse() {}, sendControlCancelRequest() {}, sendResult() {},
    async teardown() {},
  }
}

test('a slow detach cannot revoke a replacement client generation', async () => {
  const events: ModUiOutboundEvent[] = []
  const disposing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const consumers: Array<{ render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }> = []
  let mounts = 0
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: typeof consumers[number]) {
        consumers.push(consumer)
        const current = ++mounts
        consumer.render({ type: 'Text', children: [`mount-${current}`] }, current, () => ({}))
        return {
          update: async () => {}, interact: async () => {},
          async dispose() {
            if (current === 1) { disposing.resolve(); await release.promise }
          },
        }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  const detaching = controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })
  await disposing.promise
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  consumers[0]!.render({ type:'Text', children:['stale'] }, 3, () => ({}))
  release.resolve()
  await detaching
  consumers[1]!.render({ type:'Text', children:['current'] }, 4, () => ({}))
  expect(events.filter(event => event.subtype === 'render').map(event => (event as any).tree.children[0]))
    .toEqual(['mount-1', 'mount-2', 'current'])
  await controller.dispose()
})

test('a replacement attach revokes the old client before waiting for its disposal', async () => {
  const events: ModUiOutboundEvent[] = []
  const disposing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const consumers: Array<{ render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }> = []
  let mounts = 0
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: typeof consumers[number]) {
        consumers.push(consumer)
        const current = ++mounts
        consumer.render({ type: 'Text', children: [`mount-${current}`] }, current, () => ({}))
        return { update: async () => {}, interact: async () => {}, async dispose() {
          if (current === 1) { disposing.resolve(); await release.promise }
        } }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  const replacing = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  await disposing.promise
  consumers[0]!.render({ type:'Text', children:['stale'] }, 3, () => ({}))
  release.resolve()
  await replacing
  expect(events.filter(event => event.subtype === 'render').map(event => (event as any).tree.children[0]))
    .toEqual(['mount-1', 'mount-2'])
  await controller.dispose()
})

test('detach while replacement waits for old disposal cancels before mounting the replacement', async () => {
  const events: ModUiOutboundEvent[] = []
  const disposing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let mounts = 0
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }) {
        const current = ++mounts
        consumer.render({ type: 'Text', children: [`mount-${current}`] }, current, () => ({}))
        return { update: async () => {}, interact: async () => {}, async dispose() {
          if (current === 1) { disposing.resolve(); await release.promise }
        } }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  const replacing = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  await disposing.promise
  await controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })
  release.resolve()
  await replacing
  expect(mounts).toBe(1)
  expect(events.filter(event => event.subtype === 'render').map(event => (event as any).tree.children[0]))
    .toEqual(['mount-1'])
  await controller.dispose()
})

test('a concurrent attach aborts the superseded pending mount', async () => {
  const events: ModUiOutboundEvent[] = []
  const mounted = Promise.withResolvers<void>()
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const signals: AbortSignal[] = []
  let mounts = 0
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { signal?: AbortSignal; render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }) {
        const current = mounts++
        signals.push(consumer.signal!)
        if (mounts === 2) mounted.resolve()
        await releases[current]!.promise
        consumer.render({ type: 'Text', children: [`mount-${current + 1}`] }, current + 1, () => ({}))
        return { update: async () => {}, interact: async () => {}, async dispose() {} }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  const first = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  const second = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  await mounted.promise
  expect(signals[0]!.aborted).toBe(true)
  releases[0]!.resolve(); releases[1]!.resolve()
  await Promise.all([first, second])
  expect(events.filter(event => event.subtype === 'render').map(event => (event as any).tree.children[0]))
    .toEqual(['mount-2'])
  await controller.dispose()
})

test('detach while attach is mounting cannot publish or retain the pending client', async () => {
  const events: ModUiOutboundEvent[] = []
  const mounting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let disposed = 0
  let pendingSignal: AbortSignal | undefined
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { signal?: AbortSignal; render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }) {
        pendingSignal = consumer.signal
        mounting.resolve()
        await release.promise
        consumer.render({ type: 'Text', children: ['late'] }, 1, () => ({}))
        return { update: async () => {}, interact: async () => {}, async dispose() { disposed++ } }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  const attaching = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  await mounting.promise
  await controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })
  expect(pendingSignal?.aborted).toBe(true)
  release.resolve()
  await attaching
  expect(events).toEqual([])
  expect(disposed).toBe(1)
  await expect(controller.handle({ type:'mod_ui', subtype:'interact', client_id:'desktop-1', drawing:1, callback:{plugin:'test',handle:1}, kind:'press', element:'run' })).rejects.toThrow(/not attached/)
  await controller.dispose()
})

test('a failed detach still revokes the client and aborts its lifetime', async () => {
  const failure = new Error('dispose failed')
  let signal: AbortSignal | undefined
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { signal?: AbortSignal }) {
        signal = consumer.signal
        return {
          update: async () => {}, interact: async () => {},
          async dispose() { throw failure },
        }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle([]))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })

  await expect(controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })).rejects.toBe(failure)
  expect(signal?.aborted).toBe(true)
  await expect(controller.handle({ type:'mod_ui', subtype:'update', client_id:'desktop-1', surface:'desktop', input })).rejects.toThrow(/not attached/)
  await controller.dispose()
})

test('a failed replacement disposal clears the unmounted replacement generation', async () => {
  const failure = new Error('dispose failed')
  let mounts = 0
  const fakeRuntime = {
    ui: {
      async mount() {
        mounts++
        return {
          update: async () => {}, interact: async () => {},
          async dispose() { if (mounts === 1) throw failure },
        }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle([]))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })

  await expect(controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })).rejects.toBe(failure)
  await controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  expect(mounts).toBe(2)
  await controller.dispose()
})

test('session replacement aborts a pending mount and disposes its late site', async () => {
  const mounting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let disposed = 0
  let signal: AbortSignal | undefined
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { signal?: AbortSignal }) {
        signal = consumer.signal
        mounting.resolve()
        await release.promise
        return { update: async () => {}, interact: async () => {}, async dispose() { disposed++ } }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle([]))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  const attaching = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  await mounting.promise

  controller.setSession(undefined)
  expect(signal?.aborted).toBe(true)
  release.resolve()
  await attaching
  expect(disposed).toBe(1)
  await expect(controller.handle({ type:'mod_ui', subtype:'update', client_id:'desktop-1', surface:'desktop', input })).rejects.toThrow(/not attached/)
  await controller.dispose()
})

test('sender replacement aborts a pending mount and suppresses its late render', async () => {
  const events: ModUiOutboundEvent[] = []
  const mounting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { signal?: AbortSignal; render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }) {
        signal = consumer.signal
        mounting.resolve()
        await release.promise
        consumer.render({ type:'Text', children:['late'] }, 1, () => ({}))
        return { update: async () => {}, interact: async () => {}, async dispose() {} }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  const attaching = controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  await mounting.promise

  controller.setSender(handle(events))
  expect(signal?.aborted).toBe(true)
  release.resolve()
  await attaching
  expect(events).toEqual([])
  await controller.dispose()
})

test('a failed attach clears its generation and cannot suppress a later attach', async () => {
  const events: ModUiOutboundEvent[] = []
  const failure = new Error('mount failed')
  let mounts = 0
  const fakeRuntime = {
    ui: {
      async mount(_input: unknown, consumer: { render(tree: unknown, drawing: number, resolveEngine: (ref: number) => Record<string, unknown>): void }) {
        if (++mounts === 1) throw failure
        consumer.render({ type: 'Text', children: ['current'] }, 2, () => ({}))
        return { update: async () => {}, interact: async () => {}, async dispose() {} }
      },
    },
  }
  const controller = createModUiBridgeController()
  controller.setSession({ runtime: fakeRuntime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{} }
  await expect(controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })).rejects.toBe(failure)
  await controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  expect(events.filter(event => event.subtype === 'render').map(event => (event as any).tree.children[0]))
    .toEqual(['current'])
  await controller.dispose()
})

test('real desktop consumer attaches, updates, interacts with Markdown controls, and detaches', async () => {
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('ui.render', {component:'PromptHint'}, ($,e) => {
      const {Box,Markdown,Button,Input,Select}=$.ui.resolve(e);
      return Box({children:[Markdown({text:'**'+e.props.text+'**'}),
        Button({key:'run',label:'Run',onPress:()=>$.ui.status('pressed')}),
        Input({key:'query',onSubmit:(value,e)=>$.ui.status('input:'+value)}),
        Select({key:'choice',options:[{value:'a'},{value:'b'}],onSelect:(value,e)=>$.ui.status('select:'+value)})]});
    });
  }`)
  await runtime.reconcile([{ name: 'bridge-ui', storageId: 'bridge-ui@test', pluginRoot: root, entrypoints: [entry] }])
  const events: ModUiOutboundEvent[] = []
  const controller = createModUiBridgeController()
  controller.setSession({ runtime } as unknown as ModsSession)
  controller.setSender(handle(events))
  const input = { surface:'desktop' as const, component:'PromptHint' as const, requestId:'hint', props:{text:'first'}, viewport:{columns:90,rows:30} }
  await controller.handle({ type:'mod_ui', subtype:'attach', client_id:'desktop-1', surface:'desktop', input })
  const first = events.at(-1)
  expect(first?.subtype).toBe('render')
  if (first?.subtype !== 'render') throw new Error('missing render')
  const tree = first.tree as any
  expect(JSON.parse(JSON.stringify(tree)).children[0]).toEqual({type:'Markdown',props:{text:'**first**'}})
  const button = tree.children[1], inputNode = tree.children[2], select = tree.children[3]
  await controller.handle({ type:'mod_ui', subtype:'interact', client_id:'desktop-1', drawing:first.drawing, callback:button.press, kind:'press', element:'run' })
  await controller.handle({ type:'mod_ui', subtype:'interact', client_id:'desktop-1', drawing:first.drawing, callback:inputNode.press, kind:'input.submit', element:'query', value:'hello' })
  await controller.handle({ type:'mod_ui', subtype:'interact', client_id:'desktop-1', drawing:first.drawing, callback:select.press, kind:'select', element:'choice', value:'b' })
  expect(statuses).toEqual(['pressed','input:hello','select:b'])
  await controller.handle({ type:'mod_ui', subtype:'update', client_id:'desktop-1', surface:'desktop', input:{...input,props:{text:'second'}} })
  expect((events.at(-1) as any).tree.children[0].props.text).toBe('**second**')
  await controller.handle({ type:'mod_ui', subtype:'detach', client_id:'desktop-1' })
  expect(events.at(-1)).toEqual({type:'mod_ui',subtype:'unmount',client_id:'desktop-1'})
  await expect(controller.handle({ type:'mod_ui', subtype:'interact', client_id:'desktop-1', drawing:first.drawing, callback:button.press, kind:'press', element:'run' })).rejects.toThrow(/not attached/)
  await controller.dispose()
})
