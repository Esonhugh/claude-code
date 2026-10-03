import { PassThrough, Writable } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import React from 'react'
import { createRoot, render } from '../ink.js'
import type { ModRenderConsumer, ModRenderInput, ModRenderSite, ModUi, ModUiDispatch } from '../services/mods/ui.js'
import { ModsAbovePrompt } from './ModsAbovePrompt.js'
import { createModUi } from '../services/mods/ui.js'
import { createModClients } from '../services/mods/client.js'
import { createModClientRealm } from '../services/mods/clientRealm.js'
import { createModUiRealm } from '../services/mods/uiRealm.js'
import { isProxy } from 'node:util/types'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture() {
  const inputs: ModRenderInput[] = []
  const interactions: unknown[][] = []
  let consumer: ModRenderConsumer | undefined
  let disposed = 0
  let mounts = 0
  const ui = {
    async mount(input: ModRenderInput, next: ModRenderConsumer) {
      mounts++
      inputs.push(input)
      consumer = next
      await next.render({
        type: 'Button',
        props: { key: 'run', label: 'Run' },
        press: { plugin: 'fixture', handle: 3 },
      }, 7, () => ({}))
      const site: ModRenderSite = {
        getTree: () => undefined,
        async key() {}, async pointer() {}, async resize() {}, async post() {}, async advance() {},
        async update(updated) { inputs.push(updated) },
        async interact(...args) { interactions.push(args); return {} },
        async dispose() { disposed++; await next.unmount() },
      }
      return site
    },
  } as ModUi
  return { ui, inputs, interactions, consumer: () => consumer, disposed: () => disposed, mounts: () => mounts }
}

class Output extends Writable {
  columns: number
  rows: number
  isTTY = false
  output = ''

  constructor(columns = 80, rows = 24) {
    super()
    this.columns = columns
    this.rows = rows
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    this.emit('output')
    callback()
  }
}

function streams(columns = 80, rows = 24) {
  const stdout = new Output(columns, rows)
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { stdin.isRaw = value; return stdin }, ref() { return stdin }, unref() { return stdin } })
  return { stdout, stdin }
}

describe('ModsAbovePrompt', () => {
  test('renders two async continuations around the empty AbovePrompt host and unmounts normally', async () => {
    const errors: unknown[] = []
    let releases = 0
    const hooks = ['outer marker', 'inner marker'].map(marker =>
      async (input: Record<string, unknown>, next: (input: Record<string, unknown>) => Promise<unknown>) => ({
        type: 'Box',
        children: [
          {type:'Text', children:[marker]},
          await next(input),
        ],
      }))
    const dispatch: ModUiDispatch = async (_owner, event, input, core) => {
      if (event !== 'ui.render') return core(input)
      const run = (index: number, current: Record<string, unknown>): Promise<unknown> =>
        index === hooks.length ? core(current) : hooks[index]!(current, next => run(index + 1, next))
      return run(0, input)
    }
    const ui = createModUi({
      pluginOf: () => 'fixture',
      dispatch,
      draw: (owner, input, _drawing, core) => dispatch(owner, 'ui.render', input, core!, {}),
      invokeDrawing: async () => { throw new Error('unexpected drawing callback') },
      releaseDrawing: async () => { releases++ },
    })
    const io = streams()
    const app = await createRoot({stdout:io.stdout as never, stdin:io.stdin as never, patchConsole:false, exitOnCtrlC:false})
    try {
      app.render(<ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus onError={error => errors.push(error)} />)
      await tick()
      await tick()
      expect(io.stdout.output).toContain('outer marker')
      expect(io.stdout.output).toContain('inner marker')
      expect(errors).toEqual([])
    } finally {
      app.unmount()
      await tick()
      await ui.dispose()
    }
    expect(releases).toBe(1)
  })

  test('reports an unknown continuation ref instead of weakening validation', async () => {
    const errors: unknown[] = []
    const ui = {
      async mount(_input: ModRenderInput, consumer: ModRenderConsumer) {
        await consumer.render({type:'Box', children:[{type:'engine', ref:999}]}, 1, () => {
          throw new Error('Unknown or stale Mod UI engine ref')
        })
        return { async update() {}, async interact() {}, async dispose() { await consumer.unmount() } }
      },
    } as unknown as ModUi
    const io = streams()
    const app = await createRoot({stdout:io.stdout as never, stdin:io.stdin as never, patchConsole:false, exitOnCtrlC:false})
    try {
      app.render(<ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus onError={error => errors.push(error)} />)
      await tick()
      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toContain('Unknown or stale Mod UI engine ref')
    } finally {
      app.unmount()
      await tick()
    }
  })

  test('paints a production Client first frame, local action and props update, then disposes once', async () => {
    const realm = createModClientRealm(createModUiRealm('fixture', isProxy))
    const events: string[] = []
    const errors: unknown[] = []
    const rawKeys: unknown[] = []
    realm.register('counter.ts', (props: any, s) => {
      s.onKey(event => rawKeys.push(event))
      return s.elements.Button({
        key: 'increment', label: `${props.label}:${s.state ?? 0}`,
        onPress: () => s.setState(((s.state as number | undefined) ?? 0) + 1),
      })
    })
    const clients = createModClients({
      async request(_site, _plugin, request) { events.push(request.op); return realm.request(request) },
      async message() { return {} }, validate() {},
    })
    const ui = createModUi({
      clients, pluginOf: () => 'fixture',
      dispatch: async (_owner, _event, input, core) => core(input),
      draw: async (_owner, input) => ({type:'Client', props:{key:'counter',module:'counter.ts',props:{label:(input.props as any).isWorking ? 'working' : 'idle'}},group:{plugin:'fixture'}}),
      invokeDrawing: async () => { throw new Error('Client action reached drawing callbacks') },
      releaseDrawing: async () => {},
    })
    const io = streams()
    const app = await createRoot({stdout:io.stdout as never, stdin:io.stdin as never, patchConsole:false, exitOnCtrlC:false})
    const draw = (isWorking: boolean) => <ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={isWorking} view={{}} canFocus onError={error => errors.push(error)} />
    async function painted(text: string) {
      if (!io.stdout.output.includes(text)) await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!io.stdout.output.includes(text)) return
          clearTimeout(deadline)
          io.stdout.off('output', check)
          resolve()
        }
        const deadline = setTimeout(() => {
          io.stdout.off('output', check)
          reject(new Error(`Missing Client paint: ${text}; errors: ${errors.map(String).join(', ')}`))
        }, 1000)
        io.stdout.on('output', check)
      })
      expect(errors).toEqual([])
      expect(io.stdout.output).toContain(text)
    }
    app.render(draw(false))
    try {
      await painted('idle:0')
      io.stdin.write('\t')
      await tick()
      io.stdin.write('\t')
      await tick()
      io.stdin.write('\r')
      await painted('idle:1')
      app.render(draw(true))
      await painted('working:1')
      expect(rawKeys).toEqual([])
      expect(events.filter(op => op === 'press')).toHaveLength(1)
      expect(events.filter(op => op === 'mount')).toHaveLength(1)
    } finally {
      app.unmount()
      await tick()
      await ui.dispose()
    }
    expect(events.filter(op => op === 'dispose')).toHaveLength(1)
    expect(errors).toEqual([])
  })
  test('focused Client receives raw keys and a measured region above the prompt', async () => {
    const realm = createModClientRealm(createModUiRealm('fixture', isProxy))
    const keys: unknown[] = []
    const sizes: [number, number][] = []
    const focus: boolean[] = []
    const released = Promise.withResolvers<void>()
    const events: string[] = []
    const errors: unknown[] = []
    realm.register('keyboard.ts', (_props, surface) => {
      sizes.push([surface.columns, surface.rows])
      surface.onKey(event => { keys.push(event) })
      return surface.elements.Text({children:'keyboard-region'})
    })
    const clients = createModClients({
      async request(_site, _plugin, request) { events.push(request.op); return realm.request(request) },
      async message() { return {} }, validate() {},
    })
    const ui = createModUi({
      clients, pluginOf: () => 'fixture',
      dispatch: async (_owner, _event, input, core) => core(input),
      draw: async () => ({type:'Client',props:{key:'keyboard',module:'keyboard.ts',width:24,height:3},group:{plugin:'fixture'}}),
      invokeDrawing: async () => { throw new Error('raw key reached a drawing callback') },
      releaseDrawing: async () => {},
    })
    const io = streams()
    const app = await createRoot({stdout:io.stdout as never,stdin:io.stdin as never,patchConsole:false,exitOnCtrlC:false})
    try {
      app.render(<ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus onFocusChange={value => { if (!value && focus.at(-1)) released.resolve(); focus.push(value) }} onError={error => errors.push(error)} />)
      await tick()
      await tick()
      io.stdin.write('\t')
      await tick()
      io.stdin.write('k')
      await tick()
      expect(errors).toEqual([])
      expect(keys).toEqual([{key:'k'}])
      expect(sizes.at(-1)).toEqual([24,3])
      expect(focus.at(-1)).toBe(true)
      io.stdin.write('\x1b')
      await released.promise
      await tick()
      expect(focus.at(-1)).toBe(false)
      io.stdin.write('z')
      await tick()
      expect(keys).toEqual([{key:'k'}])
      expect(events.filter(op => op === 'mount')).toHaveLength(1)
    } finally { app.unmount(); await tick(); await ui.dispose() }
    expect(events.filter(op => op === 'dispose')).toHaveLength(1)
  })

  test('mounts one real terminal site and updates official props on resize and state changes', async () => {
    const host = fixture()
    const io = streams()
    io.stdout.isTTY = true
    const draw = (hasSurvey: boolean, isWorking: boolean, agentId?: string) => <ModsAbovePrompt
      ui={host.ui}
      hasSurvey={hasSurvey}
      isWorking={isWorking}
      view={agentId ? { agentId } : {}}
      canFocus={!hasSurvey}
    />
    const app = await createRoot({
      stdout: io.stdout as never, stdin: io.stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    app.render(draw(false, false))
    try {
      await tick()
      expect(host.inputs[0]).toEqual({
        surface: 'terminal', component: 'AbovePrompt', requestId: 'above-prompt',
        viewport: { columns: 80, rows: 24, isFullscreen: false },
        props: {
          hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 80,
          scroll: { offset: 0, bodyRows: 23 }, view: {},
        },
      })
      app.render(draw(true, true, 'agent-1'))
      await tick()
      expect(host.inputs.at(-1)).toMatchObject({
        surface: 'terminal', component: 'AbovePrompt', requestId: 'above-prompt',
        viewport: { columns: 80, rows: 24, isFullscreen: false },
        props: {
          hasSurvey: true, isWorking: true, maxRows: 24, bodyColumns: 80,
          scroll: { bodyRows: 23 }, view: { agentId: 'agent-1' },
        },
      })
      io.stdout.columns = 48
      io.stdout.rows = 16
      io.stdout.emit('resize')
      await tick()
      expect(host.inputs.at(-1)).toMatchObject({
        viewport:{columns:48,rows:16},
        props:{maxRows:16,bodyColumns:48,scroll:{bodyRows:15}},
      })
    } finally {
      app.unmount()
      await tick()
    }
    expect(host.mounts()).toBe(1)
    expect(host.disposed()).toBe(host.mounts())
  })

  test('applies props changed while the initial mount is pending', async () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const updates: ModRenderInput[] = []
    const updated = Promise.withResolvers<void>()
    const ui = {
      async mount() {
        entered.resolve()
        await resume.promise
        return { async update(input: ModRenderInput) { updates.push(input); updated.resolve() }, async dispose() {}, async interact() {} }
      },
    } as unknown as ModUi
    const io = streams()
    const committed = Promise.withResolvers<void>()
    function Frame({isWorking}: {isWorking:boolean}) {
      React.useEffect(() => { if (isWorking) committed.resolve() }, [isWorking])
      return <ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={isWorking} view={{}} canFocus />
    }
    const draw = (isWorking: boolean) => <Frame isWorking={isWorking} />
    const app = await createRoot({
      stdout:io.stdout as never, stdin:io.stdin as never, patchConsole:false, exitOnCtrlC:false,
    })
    app.render(draw(false))
    try {
      await entered.promise
      app.render(draw(true))
      await committed.promise
      resume.resolve()
      await updated.promise
      expect(updates.at(-1)?.props.isWorking).toBe(true)
    } finally {
      resume.resolve()
      app.unmount()
      await tick()
    }
  })

  test('disposes a late mount after unmount without publishing its frame', async () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const disposed = Promise.withResolvers<void>()
    let disposals = 0
    const ui = {
      async mount(_input: ModRenderInput, consumer: ModRenderConsumer) {
        entered.resolve()
        await resume.promise
        await consumer.render({type:'Text', children:['late frame']}, 1, () => ({}))
        return {
          async update() {}, async interact() {},
          async dispose() { disposals++; disposed.resolve() },
        }
      },
    } as unknown as ModUi
    const io = streams()
    const app = await createRoot({stdout:io.stdout as never, stdin:io.stdin as never, patchConsole:false, exitOnCtrlC:false})
    app.render(<ModsAbovePrompt ui={ui} hasSurvey={false} isWorking={false} view={{}} canFocus />)
    await entered.promise
    app.unmount()
    await tick()
    resume.resolve()
    await disposed.promise
    expect(disposals).toBe(1)
    expect(io.stdout.output).not.toContain('late frame')
  })

  test('releases composer focus when a focused drawing becomes engine fallback', async () => {
    const host = fixture()
    const io = streams()
    const focus: boolean[] = []
    const app = await createRoot({stdout:io.stdout as never, stdin:io.stdin as never, patchConsole:false, exitOnCtrlC:false})
    app.render(<ModsAbovePrompt ui={host.ui} hasSurvey={false} isWorking={false} view={{}} canFocus onFocusChange={value => focus.push(value)} />)
    try {
      await tick()
      io.stdin.write('\t')
      await tick()
      expect(focus).toContain(true)
      await host.consumer()!.render({type:'engine'}, 9, () => ({}))
      await tick()
      expect(focus.at(-1)).toBe(false)
      await host.consumer()!.render({type:'Button', props:{key:'run',label:'Run'}, press:{plugin:'fixture',handle:3}}, 10, () => ({}))
      await tick()
      io.stdin.write('\t')
      await tick()
      expect(focus.at(-1)).toBe(true)
      app.render(null)
      await tick()
      expect(focus.at(-1)).toBe(false)
    } finally {
      app.unmount()
      await tick()
    }
  })

  test('renders through the shared tree renderer and replaces drawings', async () => {
    const host = fixture()
    const io = streams()
    const app = await render(<ModsAbovePrompt ui={host.ui} hasSurvey={false} isWorking={false}
      view={{}} canFocus />, {
      stdout: io.stdout as never, stdin: io.stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await tick()
      expect(io.stdout.output).toContain('Run')
      await host.consumer()!.render({
        type: 'Text', children: ['updated frame'],
      }, 8, () => ({}))
      await tick()
      expect(io.stdout.output).toContain('updated frame')
    } finally {
      app.unmount()
    }
  })
})
