import { expect, test } from 'bun:test'
import { createModClients, type ModClientFrame } from './client.js'
import type { ModUiPane } from './ui.js'

const node = {type:'Client',props:{key:'counter',module:'counter.ts'},group:{plugin:'owner'}}
const pane = {id:'panel',owner:{},visible:true,tree:node,drawing:1} as ModUiPane

test('Client pending message props cannot commit after unmount or into its replacement', async () => {
  const posted = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<{props:unknown}>()
  const updates: unknown[] = [], commits: unknown[] = [], disposed: number[] = []
  const clients = createModClients({
    async request(_pane,_plugin,request): Promise<ModClientFrame> {
      if(request.op==='mount') return {tree:{type:'Text',children:['initial']},active:request.id===1}
      if(request.op==='frame') return {post:'request'}
      if(request.op==='update') {updates.push(request.props);return {tree:{type:'Text',children:['late']}}}
      if(request.op==='dispose') disposed.push(request.id)
      return {}
    },
    async message() {posted.resolve();return answer.promise},
    validate() {},
  })
  const old = clients.mount(pane,node,tree=>commits.push(tree))
  await old.ready;await posted.promise
  await old.dispose()
  const current = clients.mount(pane,node,tree=>commits.push(tree))
  await current.ready
  answer.resolve({props:'late'})
  await answer.promise;await Promise.resolve();await Promise.resolve()
  expect(updates).toEqual([])
  expect(commits).toEqual([{type:'Text',children:['initial']},{type:'Text',children:['initial']}])
  await current.dispose()
  expect(disposed).toEqual([1,2])
})

test('Client pending message rejection after unmount cannot fail its replacement', async () => {
  const sent = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{props:unknown}>()
  const errors: unknown[] = []
  const clients = createModClients({
    async request(_pane, _plugin, request) {
      if (request.op === 'mount') return { active: request.id === 1 }
      if (request.op === 'frame') return { post: 'old' }
      return {}
    },
    async message() { sent.resolve(); return reply.promise },
    validate() {},
  })
  const old = clients.mount(pane, node, () => {}, error => errors.push(error))
  await old.ready
  await sent.promise
  await old.dispose()
  const current = clients.mount(pane, node, () => {}, error => errors.push(error))
  await current.ready
  reply.reject(new Error('late hook failure'))
  await reply.promise.catch(() => {})
  await Promise.resolve()
  expect(errors).toEqual([])
  await current.dispose()
})

test('Client rejects no current frame when an obsolete message hook fails after a newer drawing', async () => {
  const sent = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{ props: unknown }>()
  const errors: unknown[] = []
  const requests: string[] = []
  const commits: unknown[] = []
  const clients = createModClients({
    async request(_pane, _plugin, request) {
      requests.push(request.op)
      if (request.op === 'mount') return { active: true }
      if (request.op === 'frame') return { post: 'old' }
      if (request.op === 'update') return { tree: { type: 'Text', children: ['current'] } }
      return {}
    },
    async message() { sent.resolve(); return reply.promise },
    validate() {},
  })
  const current = clients.mount(pane, node, tree => commits.push(tree), error => errors.push(error))
  try {
    await current.ready
    await sent.promise
    await current.update({ ...pane, drawing: 2 }, node)
    reply.reject(new Error('obsolete hook failed'))
    await reply.promise.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    await current.key({ key: 'k' })
    expect(errors).toEqual([])
    expect(requests).not.toContain('dispose')
    expect(requests.at(-1)).toBe('key')
    expect(commits).toEqual([{ type: 'Text', children: ['current'] }])
  } finally { await current.dispose() }
})

test('Client input arriving between frames keeps active timers scheduled', async () => {
  const ticks = Promise.withResolvers<void>()
  let frames = 0
  const clients = createModClients({
    async request(_pane, _plugin, request) {
      if (request.op === 'mount') return {active:true}
      if (request.op === 'frame') {
        if (++frames === 2) ticks.resolve()
        return {active:frames<2}
      }
      return {}
    },
    message: async () => ({}), validate() {},
  })
  const current = clients.mount(pane,node,()=>{})
  try {
    await current.ready
    await current.pointer({type:'move',x:0,y:0})
    await ticks.promise
    expect(frames).toBe(2)
  } finally {await current.dispose()}
})

test('Client ui.message props queued behind a request cannot overwrite a newer drawing', async () => {
  const posted = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{props:unknown}>()
  const blocked = Promise.withResolvers<ModClientFrame>()
  const entered = Promise.withResolvers<void>()
  const updates: unknown[] = []
  const clients = createModClients({
    async request(_pane, _plugin, request) {
      if (request.op === 'mount') return {active:true}
      if (request.op === 'frame') return {post:'request'}
      if (request.op === 'pointer') {entered.resolve();return blocked.promise}
      if (request.op === 'update') updates.push(request.props)
      return {}
    },
    async message() {posted.resolve();return reply.promise},
    validate() {},
  })
  const current = clients.mount(pane,node,()=>{})
  try {
    await current.ready
    await posted.promise
    const pointer = current.pointer({type:'down',x:0,y:0})
    await entered.promise
    reply.resolve({props:'obsolete'})
    await reply.promise
    await Promise.resolve()
    await Promise.resolve()
    const redraw = current.update({...pane,drawing:2},{...node,props:{...node.props,props:'new'}})
    blocked.resolve({})
    await pointer
    await redraw
    expect(updates).toEqual(['new'])
  } finally {await current.dispose()}
})

test('Client stale control press queued behind a redraw does not stop the current instance', async () => {
  const blocked = Promise.withResolvers<ModClientFrame>()
  const entered = Promise.withResolvers<void>()
  const requests: string[] = []
  const tree = (handle: number) => ({type:'Button',props:{key:'press'},press:{plugin:'owner',handle}})
  const clients = createModClients({
    async request(_pane,_plugin,request) {
      requests.push(request.op)
      if (request.op === 'mount') return {tree:tree(1)}
      if (request.op === 'update') {entered.resolve();return blocked.promise}
      if (request.op === 'press') throw new Error('Client callback is stale')
      return {}
    },
    message:async()=>({}),validate() {},
  })
  const errors: unknown[] = []
  const current = clients.mount(pane,node,()=>{},error=>errors.push(error))
  try {
    await current.ready
    const redraw = current.update({...pane,drawing:2},node)
    await entered.promise
    const pressed = current.press({plugin:'owner',handle:1},'press','press')
    blocked.resolve({tree:tree(2)})
    await redraw
    await pressed
    expect(requests).not.toContain('press')
    expect(requests).not.toContain('dispose')
    expect(errors).toEqual([])
  } finally {await current.dispose()}
})

test('Client failure releases its instance key before notifying the consumer', async () => {
  const requests: [string, number][] = []
  let replacement: ReturnType<ReturnType<typeof createModClients>['mount']> | undefined
  let remountError: unknown
  const clients = createModClients({
    async request(_pane, _plugin, request) {
      requests.push([request.op, request.id])
      if (request.op === 'mount' && request.id === 1) throw new Error('first render failed')
      return {}
    },
    message: async () => ({}), validate() {},
  })
  const first = clients.mount(pane, node, () => {}, () => {
    try { replacement = clients.mount(pane, node, () => {}) }
    catch (error) { remountError = error }
  })
  try {
    await expect(first.ready).rejects.toThrow('first render failed')
    expect(remountError).toBeUndefined()
    expect(replacement).toBeDefined()
    await replacement!.ready
    await first.dispose()
    expect(requests).toContainEqual(['dispose', 1])
    expect(requests).toContainEqual(['mount', 2])
  } finally { await first.dispose(); await replacement?.dispose() }
})

test('Client mount rejects duplicate keys and stale drawing snapshots', async () => {
  const clients = createModClients({request:async()=>({}),message:async()=>({}),validate:()=>{}})
  clients.reconcile([pane])
  const first=clients.mount(pane,node,()=>{})
  await first.ready
  expect(()=>clients.mount(pane,node,()=>{})).toThrow(/already mounted/)
  const next={...pane,drawing:2}
  clients.reconcile([next])
  await first.dispose()
  expect(()=>clients.mount(pane,node,()=>{})).toThrow(/stale/)
  const replacement=clients.mount(next,node,()=>{})
  await replacement.ready;await replacement.dispose()
})
