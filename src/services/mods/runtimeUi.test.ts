import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModHostServices } from './runtime.js'
import { createModsSession } from './session.js'
import type { ModUiPresentation } from './ui.js'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { render } from '../../ink.js'
import { ModsPane } from '../../components/ModsPane.js'
import stripAnsi from 'strip-ansi'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']
let saved: (string | undefined)[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-runtime-ui-'))
  saved = envKeys.map(key => process.env[key])
  for (const key of envKeys) process.env[key] = key.includes('CONFIG') || key.includes('CACHE') ? join(root, 'config') : root
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})
const wide: ModUiPresentation = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
const binding = (cwd: string) => ({ cwd, surface: 'terminal' as const, isInteractive: true, sessionId: 'ui-test' })
async function plugin(name: string, source: string) {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@test', pluginRoot, entrypoints: [entry] }
}
function fixture(overrides: ModHostServices = {}) {
  const statuses: unknown[] = [], logs: unknown[] = [], diagnostics: unknown[] = []
  const value = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: { uiPresentation: () => wide, uiStatus: (plugin, text) => { statuses.push([plugin, text]) }, uiLog: (plugin, text) => { logs.push([plugin, text]) }, ...overrides },
  })
  runtimes.push(value)
  return { value, statuses, logs, diagnostics }
}
const source = (label: string, fail = false) => `let count=0; export function register(on) {
  on('session.start', async ($,e,next) => { await $.ui.open({id:'panel',title:'${label}',focus:true}); ${fail ? "throw Error('failed UI start');" : 'return next(e);'} });
  on('ui.render', {component:'Pane'}, ($,e) => { const {Box,Button,Text}=$.ui.resolve(e); return Box({children:[Text({children:'${label}:'+count}),Button({key:'run',label:'Run',onPress:async () => { count++; await $.ui.status('${label}:'+count); await $.ui.log('clicked'); await $.ui.invalidate('ui.render'); }}),Button({key:'close',label:'Close',onPress:() => $.ui.close({id:'panel'})})]}); });
}`

// Contract: anthropics/claude-code@7974a70773fa229e4cc65aa1b356cc21f5c216c4 (2.1.277).
test('ui.resolve composes frozen per-plugin tables once at load and retires old composition on reload', async () => {
  const decoratorSource = (generation: string) => `let calls=[]; export function register(on) {
    on('ui.resolve', async ($,e,next) => {
      calls.push({keys:Object.keys(e),surface:e.surface,component:e.component});
      const elements=await next(e); const {Button,...rest}=elements;
      return {...rest,Text:props=>elements.Text({...props,color:'${generation}'})};
    });
    on('tool.call',{tool:'ResolveProbe'},async($,e)=>{const elements=$.ui.resolve({surface:e.surface,component:e.component});const text=await elements.Text({});return {result:{calls,frozen:Object.isFrozen(elements),keys:Object.keys(elements),ownSkipped:text.props.color===undefined,otherApplied:text.props.bold===true}}});
  }`
  const decorator = await plugin('resolve-decorator', decoratorSource('old'))
  const consumer = await plugin('resolve-consumer', `export function register(on) {
    on('ui.resolve',async($,e,next)=>{const elements=await next(e);return {...elements,Text:props=>elements.Text({...props,bold:true})}});
    on('session.start',async($,e,next)=>{await $.ui.open({id:'resolved'});return next(e)});
    on('ui.render',($,e)=>{const elements=$.ui.resolve(e);return elements.Text({children:String(Boolean(elements.Button))})});
    on('tool.call',{tool:'ConsumerProbe'},($,e)=>{const elements=$.ui.resolve({surface:e.surface,component:e.component});const text=elements.Text({});return {result:{frozen:Object.isFrozen(elements),generation:text.props.color}}});
  }`)
  const {value,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([decorator,consumer])

  const expected=4*15
  const decoratorProbe=await value.dispatch('tool.call',{tool:'ResolveProbe',surface:'terminal',component:'Pane'},async()=>({result:null})) as any
  expect(decoratorProbe.result.calls).toHaveLength(expected)
  expect(decoratorProbe.result.calls.every((call:any)=>call.keys.join(',')==='surface,component')).toBe(true)
  expect(decoratorProbe.result.frozen).toBe(true)
  expect(decoratorProbe.result.keys).toContain('Button')
  expect(decoratorProbe.result).toMatchObject({ownSkipped:true,otherApplied:true})
  const consumerProbe=await value.dispatch('tool.call',{tool:'ConsumerProbe',surface:'terminal',component:'Pane'},async()=>({result:null})) as any
  expect(consumerProbe.result).toEqual({frozen:true,generation:'old'})
  expect(diagnostics).toEqual([])
  expect(value.ui.getSnapshot()[0]!.tree).toMatchObject({type:'Text',props:{color:'old'},children:['false']})

  await writeFile(decorator.entrypoints[0]!,decoratorSource('new'))
  await value.reconcile([decorator,consumer])
  const reloaded=await value.dispatch('tool.call',{tool:'ResolveProbe',surface:'terminal',component:'Pane'},async()=>({result:null})) as any
  expect(reloaded.result.calls).toHaveLength(expected)
  expect(value.ui.getSnapshot()[0]!.tree).toMatchObject({type:'Text',props:{color:'new'},children:['false']})
  expect(diagnostics).toEqual([])
})

test('Raster and Image constructors cross the production Worker and render in the terminal consumer', async () => {
  const cells = Buffer.alloc(24)
  cells.writeUInt32LE('A'.charCodeAt(0), 0)
  cells.writeUInt32LE(0x00ff0000, 4)
  cells.writeUInt32LE(0x01000000, 8)
  cells.writeUInt32LE('B'.charCodeAt(0), 12)
  cells.writeUInt32LE(0x01000000, 16)
  cells.writeUInt32LE(0x01000000, 20)
  const consumer = await plugin('media-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>{const {Box,Raster,Image}=$.ui.resolve(e);return Box({children:[
      Raster({key:'pixels',columns:2,rows:1,cells:'${cells.toString('base64')}'}),
      Image({key:'preview',source:{rgba:'${Buffer.alloc(4).toString('base64')}',width:1,height:1},columns:8,rows:2,alt:'image fallback'})
    ]})});
  }`)
  const {value,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  const pane=value.ui.getSnapshot()[0]!
  expect(pane.tree).toMatchObject({children:[{type:'Raster'},{type:'Image'}]})
  const stdout=Object.assign(new Writable({write(chunk,_encoding,callback){callback()}}),{columns:80,rows:30,isTTY:false,output:''})
  const write=stdout._write.bind(stdout)
  stdout._write=(chunk,encoding,callback)=>{stdout.output+=chunk.toString();write(chunk,encoding,callback)}
  const stdin=Object.assign(new Readable({read(){}}),{isTTY:true,isRaw:false,setRawMode(){return this},ref(){return this},unref(){return this}})
  const instance=await render(React.createElement(ModsPane,{pane,onInteract:async()=>{},onClose:async()=>{},onFocus:async()=>({}),onScroll:async()=>({})}),{stdout:stdout as unknown as NodeJS.WriteStream,stdin:stdin as unknown as NodeJS.ReadStream,patchConsole:false,exitOnCtrlC:false})
  try {
    await new Promise(resolve=>setTimeout(resolve,20))
    expect(stripAnsi(stdout.output)).toContain('AB')
    expect(stripAnsi(stdout.output)).toContain('image f')
  } finally {instance.unmount();instance.cleanup()}
})

test('ui.blit denies Image updates until a terminal frame consumer is writable', async () => {
  const initial = { file: '/tmp/initial.png', format: 'png' }
  const changed = { file: '/tmp/changed.png', format: 'png' }
  const consumer = await plugin('image-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'shown'});await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>e.requestId==='media'
      ? $.ui.resolve(e).Image({key:'preview',source:${JSON.stringify(initial)},columns:8,rows:2,alt:'fallback'})
      : $.ui.resolve(e).Text({children:'shown'}));
    on('command.run',async($)=>{await $.ui.status(JSON.stringify(await $.ui.blit({requestId:'media',key:'preview',source:${JSON.stringify(changed)}})));return {}});
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  await value.dispatch('command.run',{command:'blit',args:'',origin:{kind:'composer'}},async()=>({}))
  expect(statuses).toEqual([['image-owner',JSON.stringify({deny:'terminal image frames cannot be written'})]])
  expect((value.ui.getSnapshot().find(pane=>pane.id==='media')!.tree as any).props.source).toEqual(initial)
  expect(diagnostics).toEqual([])
})

test('ui.blit updates an owned mounted Raster without rerunning ui.render and rejects stale dimensions', async () => {
  const cell = (character: string) => {
    const bytes = Buffer.alloc(12)
    bytes.writeUInt32LE(character.charCodeAt(0), 0)
    bytes.writeUInt32LE(0x01000000, 4)
    bytes.writeUInt32LE(0x01000000, 8)
    return bytes.toString('base64')
  }
  const consumer = await plugin('blit-owner', `let draws=0; export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>{draws++;return $.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cell('A')}'})});
    on('command.run',async($)=>{
      const changed=await $.ui.blit({requestId:'media',key:'pixels',cells:'${cell('B')}',columns:1,rows:1});
      const wrong=await $.ui.blit({requestId:'media',key:'pixels',cells:'${cell('C')}',columns:2,rows:1});
      await $.ui.status(JSON.stringify({changed,wrong,draws}));return {};
    });
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  const before=value.ui.getSnapshot()[0]!
  expect({before:Boolean(before),diagnostics}).toEqual({before:true,diagnostics:[]})
  await value.dispatch('command.run',{command:'blit',args:'',origin:{kind:'composer'}},async()=>({}))
  const after=value.ui.getSnapshot()[0]!
  expect(after.drawing).toBe(before.drawing)
  expect((after.tree as any).props.cells).toBe(cell('B'))
  expect(statuses).toEqual([['blit-owner',JSON.stringify({changed:{},wrong:{deny:'mounted dimensions do not match'},draws:1})]])
  expect(diagnostics).toEqual([])
})

test('ui.blit middleware may rewrite payload but cannot redirect the mounted address or kind', async () => {
  const cell = (character: string) => {
    const bytes = Buffer.alloc(12)
    bytes.writeUInt32LE(character.charCodeAt(0), 0)
    bytes.writeUInt32LE(0x01000000, 4)
    bytes.writeUInt32LE(0x01000000, 8)
    return bytes.toString('base64')
  }
  const policy = await plugin('blit-policy', `export function register(on) {
    on('ui.blit',async($,e,next)=>{
      if(e.cells==='${cell('B')}') return next({...e,cells:'${cell('C')}'});
      try {await next({...e,key:'other'})} catch(error) {await $.ui.status(error.message)}
      try {await next({...e,cells:undefined,source:{png:'AAAA'}})} catch(error) {await $.ui.status(error.message)}
      return next(e);
    });
  }`)
  const consumer = await plugin('blit-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cell('A')}'}));
    on('command.run',async($,e)=>{await $.ui.blit({requestId:'media',key:'pixels',cells:e.args==='rewrite'?'${cell('B')}':'${cell('D')}'});return {}});
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([policy,consumer])
  await value.dispatch('command.run',{command:'blit',args:'rewrite',origin:{kind:'composer'}},async()=>({}))
  expect((value.ui.getSnapshot()[0]!.tree as any).props.cells).toBe(cell('C'))
  await value.dispatch('command.run',{command:'blit',args:'guards',origin:{kind:'composer'}},async()=>({}))
  expect((value.ui.getSnapshot()[0]!.tree as any).props.cells).toBe(cell('D'))
  expect(statuses).toEqual([
    ['blit-policy','Mod UI blit cannot rewrite requestId or key'],
    ['blit-policy','Mod UI blit cannot change the mounted element kind'],
  ])
  expect(diagnostics).toEqual([])
})

test('ui.blit cannot address another plugin drawing and expires after close', async () => {
  const bytes = Buffer.alloc(12)
  bytes.writeUInt32LE('A'.charCodeAt(0), 0)
  bytes.writeUInt32LE(0x01000000, 4)
  bytes.writeUInt32LE(0x01000000, 8)
  const cells = bytes.toString('base64')
  const owner = await plugin('blit-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cells}'}));
  }`)
  const stranger = await plugin('blit-stranger', `export function register(on) {
    on('command.run',async($)=>{const result=await $.ui.blit({requestId:'media',key:'pixels',cells:'${cells}'});await $.ui.status(JSON.stringify(result));return {}});
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([owner,stranger])
  await value.dispatch('command.run',{command:'blit',args:'',origin:{kind:'composer'}},async()=>({}))
  expect(statuses).toEqual([['blit-stranger',JSON.stringify({deny:'no owned Raster or Image is mounted under that key'})]])
  const pane=value.ui.getSnapshot()[0]!
  await value.ui.close(pane.owner,pane.id,{kind:'person'})
  expect(await value.ui.blit(pane.owner,{requestId:pane.id,key:'pixels',cells})).toEqual({deny:'site is not open'})
  expect(diagnostics).toEqual([])
})

test('Client loads its surface module through the production Worker and renders supplied props', async () => {
  const consumer = await plugin('client-owner', `export function register(on) {
    on('session.start', async ($,e,next) => {await $.ui.open({id:'panel'});return next(e)});
    on('ui.render', ($,e) => $.ui.resolve(e).Client({key:'counter',module:'./counter.ts',props:{label:'first'}}));
    on('ui.message', ($,e) => ({props:{label:e.data}}));
  }`)
  await writeFile(join(consumer.pluginRoot, 'counter.ts'), `export default function Counter(props, surface) {
    return surface.elements.Text({children:props.label});
  }`)
  const {value, diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  const pane = value.ui.getSnapshot()[0]!
  const frames: any[] = []
  const client = pane.clients!.mount(pane, pane.tree, tree => frames.push(tree))
  try {
    await client.ready
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({type:'Text',children:['first']})
    expect(await value.ui.focus(pane.owner, {requestId:pane.id,element:'counter',origin:{kind:'person'}}, wide)).toMatchObject({focused:true,element:'counter'})
  } finally { await client.dispose() }
})

test('Client post reaches only its real Worker ui.message hooks and returns props without ui.render', async () => {
  const observer = await plugin('observer', `export function register(on) {on('ui.message', () => {throw Error('cross-plugin message leak')})}`)
  const consumer = await plugin('client-owner', `let draws=0; export function register(on) {
    on('session.start', async ($,e,next) => {await $.ui.open({id:'panel'});return next(e)});
    on('ui.render', ($,e) => {draws++;return $.ui.resolve(e).Client({key:'counter',module:'./counter.ts',props:{label:'first'}})});
    on('ui.message', async ($,e,next) => {
      await $.ui.status(JSON.stringify({e,origin:next.origin,draws}));
      return {props:{label:e.data}};
    });
  }`)
  await writeFile(join(consumer.pluginRoot, 'counter.ts'), `export default function Counter(props, s) {
    if(s.state===undefined) {s.setState(7);s.post('discarded');s.post('answer')}
    return s.elements.Text({children:props.label+':'+s.state});
  }`)
  const {value, diagnostics, statuses} = fixture()
  await value.bind(binding(root)); await value.reconcile([observer, consumer])
  expect(diagnostics).toEqual([])
  const pane = value.ui.getSnapshot()[0]!
  const done = Promise.withResolvers<void>()
  const frames: any[] = []
  const client = pane.clients!.mount(pane, pane.tree, tree => {
    frames.push(tree)
    if ((tree as any).children[0] === 'answer:7') done.resolve()
  }, done.reject)
  try {
    await client.ready
    await done.promise
    expect(statuses).toHaveLength(1)
    expect(JSON.parse((statuses[0] as string[])[1]!)).toEqual({
      e:{surface:'terminal',component:'Pane',requestId:'panel',element:'counter',module:'counter.ts',data:'answer'},
      origin:{plugin:'client',tier:'user'},draws:1,
    })
    expect(frames.at(-1).children).toEqual(['answer:7'])
    expect(value.ui.getSnapshot()[0]!.drawing).toBe(pane.drawing)
    expect(diagnostics).toEqual([])
  } finally { await client.dispose() }
})

test('Client keyed redraw keeps independent state, cancels pending posts and cleans timers on close', async () => {
  const consumer = await plugin('client-owner', `let swapped=false; export function register(on) {
    on('session.start', async ($,e,next) => {await $.ui.open({id:'panel'});return next(e)});
    on('ui.render', ($,e) => {const {Box,Client}=$.ui.resolve(e);return Box({children:[
      Client({key:'a',module:'./counter.ts',props:{label:swapped?'new':'a'}}),
      Client({key:'b',module:'./counter.ts',props:{label:'b'}})
    ]})});
    on('ui.message', async ($,e) => {await $.ui.status(e.element+':'+e.data);return {}});
    on('command.run',async ($,e) => {swapped=true;await $.ui.invalidate('ui.render');return {}});
  }`)
  await writeFile(join(consumer.pluginRoot, 'counter.ts'), `export default function Counter(props, s) {
    if(s.state===undefined) {
      s.setState(0);
      s.every(20, () => s.post('tick'));
      s.onPointer(() => {s.setState(s.state+1);s.setState(s.state+1)});
      s.onKey(() => s.setState(s.state+1));
    }
    return s.elements.Text({children:props.label+':'+s.state});
  }`)
  const tick = Promise.withResolvers<void>()
  let ticks = 0
  const {value, diagnostics} = fixture({uiStatus: () => {ticks++;tick.resolve()}})
  await value.bind(binding(root)); await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  let pane = value.ui.getSnapshot()[0]!
  const frames: any[][] = [[], []]
  const changed = Promise.withResolvers<void>()
  const handles = (pane.tree as any).children.map((node: unknown, index: number) => pane.clients!.mount(pane,node,tree => {
    frames[index]!.push(tree)
    if(index===0 && (tree as any).children[0]==='a:2') changed.resolve()
  },changed.reject))
  try {
    await Promise.all(handles.map((handle: any) => handle.ready))
    await handles[0].pointer({type:'down',x:0,y:0})
    await changed.promise
    await tick.promise
    expect(ticks).toBeGreaterThan(0)
    expect(frames[0]!.filter(tree => tree.children[0]==='a:2')).toHaveLength(1)
    expect(frames[1]!.at(-1).children).toEqual(['b:0'])
    await value.dispatch('command.run',{command:'redraw',args:''},async () => ({}))
    pane = value.ui.getSnapshot()[0]!
    await Promise.all(handles.map((handle: any,index: number) => handle.update(pane,(pane.tree as any).children[index])))
    expect(frames[0]!.at(-1).children).toEqual(['new:2'])
    expect(frames[1]!.at(-1).children).toEqual(['b:0'])
    await value.ui.close(pane.owner,pane.id,{kind:'person'})
    const count = frames.map(items => items.length)
    await Promise.all(handles.map((handle: any) => handle.dispose()))
    await handles[0].pointer({type:'down',x:0,y:0});await handles[1].key({key:'a'})
    expect(frames.map(items => items.length)).toEqual(count)
    expect(diagnostics).toEqual([])
  } finally { await Promise.all(handles.map((handle: any) => handle.dispose())) }
})

test('Client local Button callback uses the Worker instance lease and expires on redraw and unmount', async () => {
  const consumer = await plugin('client-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Client({key:'button',module:'./button.ts'}));
  }`)
  await writeFile(join(consumer.pluginRoot, 'button.ts'), `export default function Button(props,s) {
    if(s.state===undefined)s.setState(0);
    return s.elements.Button({key:'increment',label:String(s.state),onPress:()=>s.setState(s.state+1)});
  }`)
  const {value,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  const pane=value.ui.getSnapshot()[0]!
  let current:any
  const changed=Promise.withResolvers<void>()
  const handle=pane.clients!.mount(pane,pane.tree,tree=>{current=tree;if(current.props.label==='1')changed.resolve()},changed.reject)
  try {
    await handle.ready
    const first=current.press
    await handle.press(first,'press','increment')
    await changed.promise
    expect(current.props.label).toBe('1')
    await expect(handle.press(first,'press','increment')).rejects.toThrow(/stale/)
    await handle.dispose()
    await expect(handle.press(current.press,'press','increment')).rejects.toThrow(/stale/)
    expect(diagnostics).toEqual([])
  } finally {await handle.dispose()}
})

test('Client local Input and Select receive their complete drawing context in the Worker', async () => {
  const consumer = await plugin('client-controls', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'controls'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Client({key:'form',module:'./form.ts'}));
    on('ui.message',async($,e)=>{await $.ui.status(JSON.stringify(e.data));return {}});
  }`)
  await writeFile(join(consumer.pluginRoot, 'form.ts'), `export default function Form(props,s) {
    return s.elements.Box({children:[
      s.elements.Input({key:'input',onSubmit:(value,event)=>s.post({value,event})}),
      s.elements.Select({key:'select',options:[{value:'one'}],onSelect:(value,event)=>s.post({value,event})})
    ]});
  }`)
  const posted: unknown[] = []
  let nextPost = Promise.withResolvers<void>()
  const {value,diagnostics}=fixture({uiStatus:(_plugin,text)=>{if(text!==undefined){posted.push(JSON.parse(text));nextPost.resolve()}}})
  await value.bind(binding(root));await value.reconcile([consumer])
  const pane=value.ui.getSnapshot()[0]!
  let tree: any
  const handle=pane.clients!.mount(pane,pane.tree,current=>{tree=current})
  try {
    await handle.ready
    await handle.press(tree.children[0].press,'input.submit','input','typed')
    await nextPost.promise
    expect(posted[0]).toEqual({value:'typed',event:{plugin:'client-controls',surface:'terminal',component:'Pane',requestId:'controls',element:'input',kind:'submit',value:'typed'}})
    nextPost=Promise.withResolvers<void>()
    await handle.press(tree.children[1].press,'select','select','one')
    await nextPost.promise
    expect(posted[1]).toEqual({value:'one',event:{plugin:'client-controls',surface:'terminal',component:'Pane',requestId:'controls',element:'select',value:'one'}})
    expect(diagnostics).toEqual([])
  } finally {await handle.dispose()}
})

test('Client ui.message pins the envelope and permits only data rewrites', async () => {
  const consumer = await plugin('client-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Client({key:'counter',module:'./counter.ts'}));
    on('ui.message',async($,e,next)=>{
      for(const key of ['surface','component','requestId','element','module']) {
        try {await next({...e,[key]:'forged'})} catch(error) {await $.ui.status(error.message)}
      }
      return next({...e,data:'rewritten'});
    });
    on('ui.message',($,e)=>({props:e.data}));
  }`)
  await writeFile(join(consumer.pluginRoot, 'counter.ts'), `export default function Counter(props,s) {
    if(s.state===undefined){s.setState(1);s.post('original')}
    return s.elements.Text({children:props??'waiting'});
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  const pane=value.ui.getSnapshot()[0]!
  const done=Promise.withResolvers<void>()
  const handle=pane.clients!.mount(pane,pane.tree,tree=>{if((tree as any).children[0]==='rewritten')done.resolve()},done.reject)
  try {
    await handle.ready;await done.promise
    expect(statuses).toEqual(['surface','component','requestId','element','module'].map(key=>['client-owner',`Mod client-owner cannot rewrite ${key} for ui.message`]))
    expect(diagnostics).toEqual([])
  } finally {await handle.dispose()}
})

test('Client production loader and Worker commit a ui.message answer into the actual Ink consumer', async () => {
  const consumer=await plugin('client-owner',`export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Client({key:'ink',module:'./ink.ts',width:20,height:1}));
    on('ui.message',()=>({props:'worker-to-ink'}));
  }`)
  await writeFile(join(consumer.pluginRoot,'ink.ts'),`export default function Ink(props,s) {
    if(s.state===undefined){s.setState(1);s.post('ready')}
    return s.elements.Text({children:props??'loading'});
  }`)
  const {value,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  const pane=value.ui.getSnapshot()[0]!
  const drawn=Promise.withResolvers<void>()
  let output=''
  const stdout=Object.assign(new Writable({write(chunk,_encoding,callback){
    output+=chunk.toString();if(stripAnsi(output).includes('worker-to-ink'))drawn.resolve();callback()
  }}),{columns:80,rows:30,isTTY:false})
  const stdin=Object.assign(new Readable({read(){}}),{isTTY:true,isRaw:false,setRawMode(){return this},ref(){return this},unref(){return this}})
  const instance=await render(React.createElement(ModsPane,{
    pane,onInteract:async()=>{},onClose:async()=>{},onFocus:async()=>({}),onScroll:async()=>({}),onError:drawn.reject,
  }),{stdout:stdout as unknown as NodeJS.WriteStream,stdin:stdin as unknown as NodeJS.ReadStream,patchConsole:false,exitOnCtrlC:false})
  try {
    await drawn.promise
    expect(stripAnsi(output)).toContain('worker-to-ink')
    expect(diagnostics).toEqual([])
  } finally {instance.unmount();instance.cleanup()}
})

test('ui.render validates each Worker result inside catch without rerunning the completed drawing', async () => {
  const decorator = await plugin('decorator', `let caught; export function register(on) {
    on('ui.render', async ($,e,next) => {await next(e);return {type:'NotAnElement'}})
      .catch(async ($,e,next) => {caught=next.error.message;return next(e)});
    on('tool.call', {tool:'Caught'}, () => ({result:caught}));
  }`)
  const owner = await plugin('ui-owner', `let draws=0; export function register(on) {
    on('session.start',async ($,e,next) => {await $.ui.open({id:'panel'});return next(e)});
    on('ui.render',($,e) => {draws++;return $.ui.resolve(e).Button({key:'press',label:'Recovered',onPress:() => $.ui.status('pressed')})});
    on('tool.call', {tool:'Draws'}, () => ({result:draws}));
  }`)
  const {value,diagnostics,statuses} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,owner])
  const pane=value.ui.getSnapshot()[0]!
  expect(pane).toBeDefined()
  expect((pane.tree as any).props.label).toBe('Recovered')
  expect(await value.dispatch('tool.call',{tool:'Caught'},async () => ({result:'unexpected'}))).toEqual({result:'Unsupported UI element NotAnElement'})
  expect(await value.dispatch('tool.call',{tool:'Draws'},async () => ({result:'unexpected'}))).toEqual({result:1})
  await value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).press,'press','press')
  expect(statuses).toEqual([['ui-owner','pressed']])
  expect(diagnostics).toEqual([expect.objectContaining({plugin:'decorator',stage:'ui.render',message:'Unsupported UI element NotAnElement'})])
})

test('ui.render refuses forged envelope and readonly Pane props before any downstream reader', async () => {
  const decorator = await plugin('decorator', `let failures=[]; export function register(on) {
    on('ui.render', async ($,e,next) => {
      for (const changed of [
        {...e,surface:'desktop'}, {...e,component:'PromptHint'}, {...e,requestId:'fake'},
        {...e,viewport:{...e.viewport,isFullscreen:false}},
        {...e,props:{...e.props,title:'fake'}}, {...e,props:{...e.props,view:{agentId:'fake'}}},
        {...e,props:{...e.props,placement:'inline'}}, {...e,props:{...e.props,scroll:{offset:999,bodyRows:1}}}
      ]) {try {await next(changed)} catch(error) {failures.push(error.message)}}
      return next(e);
    });
    on('tool.call', {tool:'Failures'}, () => ({result:failures}));
  }`)
  const owner = await plugin('ui-owner', `let received=[]; export function register(on) {
    on('session.start',async ($,e,next) => {await $.ui.open({id:'panel'});return next(e)});
    on('ui.render',($,e) => {received.push(e);return $.ui.resolve(e).Text({children:'body'})});
    on('tool.call', {tool:'Received'}, () => ({result:received}));
  }`)
  const {value,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,owner])
  expect(diagnostics).toEqual([])
  const failures = await value.dispatch('tool.call',{tool:'Failures'},async () => ({result:'unexpected'})) as any
  expect(failures.result).toEqual(['surface','component','requestId','viewport','props','props','props','props'].map(key => `Mod decorator cannot rewrite ${key} for ui.render`))
  const received = await value.dispatch('tool.call',{tool:'Received'},async () => ({result:'unexpected'})) as any
  expect(received.result).toHaveLength(1)
  expect(received.result[0]).toMatchObject({surface:'terminal',component:'Pane',requestId:'panel',viewport:{isFullscreen:true},props:{view:{},placement:'dock'}})
})

test('ui.log preserves default, debug and rewritten sinks across activation buffering', async () => {
  const logs: unknown[]=[]
  const policy=await plugin('log-policy',`export function register(on) {
    on('ui.log', {text:'rewrite'}, ($,e,next)=>next({...e,to:'debug'}));
  }`)
  const owner=await plugin('logger',`export function register(on) {
    on('session.start',async($,e,next)=>{
      await $.ui.log('default'); await $.ui.log('debug',{to:'debug'}); await $.ui.log('rewrite'); return next(e);
    });
    on('tool.call',async($)=>{
      await $.ui.log('live',{to:'debug'});
      let rejected=false; try{await $.ui.log('invalid',{to:'other'});}catch{rejected=true;}
      return {result:rejected};
    });
  }`)
  const {value,diagnostics}=fixture({uiLog:(plugin,text,to)=>logs.push([plugin,text,to])})
  await value.bind(binding(root)); await value.reconcile([policy,owner])
  expect(logs).toEqual([['logger','default','transcript'],['logger','debug','debug'],['logger','rewrite','debug']])
  expect(await value.dispatch('tool.call',{tool:'Probe'},async()=>({result:'core'}))).toEqual({result:true})
  expect(logs.at(-1)).toEqual(['logger','live','debug'])
  expect(logs).toHaveLength(4)
  expect(diagnostics).toEqual([])
  const failed=await plugin('failed-logger',`export function register(on) {
    on('session.start',async($)=>{await $.ui.log('completed before failure',{to:'debug'});throw Error('failed start');});
  }`)
  await value.reconcile([policy,owner,failed])
  expect(logs).toHaveLength(5)
  expect(logs.at(-1)).toEqual(['failed-logger','completed before failure','debug'])
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'failed-logger',stage:'session.start'}))
})

test('real Worker session.start opens a pane, redraws after a leased callback, closes and reloads', async () => {
  const consumer = await plugin('ui-owner', source('old'))
  const { value, statuses, logs, diagnostics } = fixture()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  const first = value.ui.getSnapshot()[0]!
  expect(first).toMatchObject({ id:'panel', title:'old', visible:true, placement:'dock' })
  const tree = first.tree as any
  await value.ui.interact(first.id, first.drawing!, tree.children[1].press, 'press', 'run')
  expect(statuses).toEqual([['ui-owner','old:1']])
  expect(logs).toEqual([['ui-owner','clicked']])
  const second = value.ui.getSnapshot()[0]!
  expect((second.tree as any).children[0].children).toEqual(['old:1'])
  const releasedCallback = await (first.owner as any).environment.invokeDrawing(first.drawing, tree.children[1].press.handle, [{}]).then(() => null, (error: Error) => error)
  expect(releasedCallback?.message).toContain('Unknown drawing callback')
  await expect(value.ui.interact(second.id, second.drawing!, {plugin:'unknown',handle:(second.tree as any).children[1].press.handle}, 'press', 'run')).rejects.toThrow(/stale/)
  await expect(value.ui.interact(first.id, first.drawing!, tree.children[1].press, 'press', 'run')).rejects.toThrow(/stale/)
  await writeFile(consumer.entrypoints[0]!, source('new'))
  await value.reconcile([consumer])
  expect(value.ui.getSnapshot()[0]!.title).toBe('new')
  await expect(value.ui.interact(second.id, second.drawing!, (second.tree as any).children[1].press, 'press', 'run')).rejects.toThrow(/stale/)
  const current = value.ui.getSnapshot()[0]!
  await value.ui.interact(current.id, current.drawing!, (current.tree as any).children[2].press, 'press', 'close')
  expect(value.ui.getSnapshot()).toEqual([])
  expect(diagnostics).toEqual([])
})

test('a publication failure keeps the previous drawing and suppresses candidate UI side effects', async () => {
  const consumer = await plugin('ui-owner', source('old'))
  const blocker = await plugin('blocker', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.command.register({name:'taken',description:'Blocker'});return next(e)});
  }`)
  const { value, statuses, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([blocker,consumer])
  const snapshot = value.ui.getSnapshot()
  await writeFile(consumer.entrypoints[0]!, source('failed', true).replace("throw Error('failed UI start')", "await $.ui.status('must not publish'); await $.command.register({name:'taken',description:'Conflict'}); throw Error('failed UI start')"))
  await value.reconcile([blocker,consumer])
  expect(value.ui.getSnapshot()).toBe(snapshot)
  expect(statuses).toEqual([])
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'ui-owner',message:expect.stringContaining('already owned')}))
  await value.reconcile([])
  expect(value.ui.getSnapshot()).toEqual([])
})

test('a recovered replacement start publishes the completed pane and its new callbacks', async () => {
  const consumer=await plugin('ui-owner',source('old'))
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  const previous=value.ui.getSnapshot()[0]!
  await writeFile(consumer.entrypoints[0]!,source('recovered',true))
  await value.reconcile([consumer])
  const current=value.ui.getSnapshot()[0]!
  expect(current.title).toBe('recovered')
  expect(current.drawing).not.toBe(previous.drawing)
  await expect(value.ui.interact(previous.id,previous.drawing!,(previous.tree as any).children[1].press,'press','run')).rejects.toThrow(/stale/)
  await value.ui.interact(current.id,current.drawing!,(current.tree as any).children[1].press,'press','run')
  expect(statuses).toEqual([['ui-owner','recovered:1']])
  expect(diagnostics).toEqual([expect.objectContaining({plugin:'ui-owner',stage:'session.start',message:'failed UI start'})])
})

test('engine.create withholding revokes even a captured synchronous UI resolve bridge', async () => {
  const consumer = await plugin('ui-owner', `let saved; export function register(on) {
    on('tool.call', ($,e) => { saved ??= () => $.ui.resolve({surface:'terminal',component:'Pane'}).Text({children:'ok'}); return {result:saved()}; });
  }`)
  const policy = await plugin('policy', `export function register(on) { on('engine.create', async ($,e,next) => {const below=await next(e); return {clock:below.clock,fs:below.fs,process:below.process,store:below.store,session:below.session,command:below.command};}); }`)
  const { value, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const input = {tool:'Read',tool_use_id:'test'}
  const initial = await value.dispatch('tool.call', input, async () => ({result:'core'}))
  expect(diagnostics).toEqual([])
  expect(initial).toMatchObject({result:{type:'Text'}})
  const oldGeneration = value.capture()
  await value.reconcile([policy,consumer])
  expect(diagnostics).toEqual([])
  try {
    expect(await oldGeneration.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  } finally { oldGeneration.release() }
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'ui-owner',message:expect.stringMatching(/withdrawn|withheld/)}))
})

test('person opening policy follows command.run origin, not the command name', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('command.run', async ($,e) => { await $.ui.open({id:e.args}); return {}; });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'body'}));
  }`)
  const { value, diagnostics } = fixture({uiPresentation: () => ({...wide,columns:80,isFullscreen:false})})
  await value.bind(binding(root)); await value.reconcile([consumer])
  for (const [id,kind] of [['person','composer'],['shortcut','shortcut'],['auto','plugin']]) {
    await value.dispatch('command.run',{command:'arbitrary',args:id,origin:{kind},presentation:{columns:80,isFullscreen:false}},async () => ({}))
  }
  expect(value.ui.getSnapshot().map(pane => [pane.id,pane.visible])).toEqual([['person',true],['shortcut',true],['auto',false]])
  expect(diagnostics).toEqual([])
})

test('a timer scheduled by a person command does not retain person UI opening privilege', async () => {
  const consumer = await plugin('ui-owner',`export function register(on) {
    on('command.run',($,e) => {$.clock.after(1,async () => {await $.ui.open({id:'timer'}); await $.ui.status('timer done')}); return {};});
    on('ui.render',($,e) => $.ui.resolve(e).Text({children:'body'}));
  }`)
  const done = Promise.withResolvers<void>()
  const {value,diagnostics} = fixture({uiPresentation:() => ({...wide,columns:80}),uiStatus:() => done.resolve()})
  await value.bind(binding(root)); await value.reconcile([consumer])
  await value.dispatch('command.run',{command:'any',args:'',origin:{kind:'composer'},presentation:{columns:80,isFullscreen:true}},async () => ({}))
  await done.promise
  expect(value.ui.getSnapshot()[0]).toMatchObject({id:'timer',visible:false})
  expect(diagnostics).toEqual([])
})

test('public ui.focus addresses the calling plugin element and raises one plugin-origin focus event', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel',focus:true}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Button}=$.ui.resolve(e); return Box({children:[
      Button({key:'first',label:'First',onPress:()=>{}}),
      Button({key:'second',label:'Second',onPress:()=>{}}),
    ]}); });
    on('command.run', async ($,e) => { const result=await $.ui.focus({requestId:'panel',key:'second'}); await $.ui.status(JSON.stringify(result)); return {}; });
  }`)
  const policy = await plugin('focus-policy', `export function register(on) {
    on('ui.focus', async ($,e,next) => { await $.ui.status(JSON.stringify(e)); return next(e); });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([policy,consumer])

  await value.dispatch('command.run',{command:'focus',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(diagnostics).toEqual([])
  expect(statuses).toEqual([
    ['focus-policy',JSON.stringify({component:'Pane',requestId:'panel',plugin:'ui-owner',element:'second',origin:{kind:'plugin',name:'ui-owner'}})],
    ['ui-owner','{}'],
  ])
  expect(value.ui.getSnapshot()[0]).toMatchObject({focused:true,focusedElement:'second'})
})

test('person focus enters an unfocused Worker pane while public plugin focus cannot steal it', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Button}=$.ui.resolve(e); return Box({children:[
      Button({key:'first',label:'First',onPress:()=>{}}),
      Button({key:'second',label:'Second',onPress:()=>{}}),
    ]}); });
    on('command.run', async ($) => { await $.ui.status(JSON.stringify(await $.ui.focus({requestId:'panel',key:'first'}))); return {}; });
  }`)
  const policy = await plugin('focus-policy', `let mode='rewrite'; export function register(on) {
    on('command.run', ($,e,next) => { if(e.command==='mode'){mode=e.args;return {};} return next(e); });
    on('ui.focus', ($,e,next) => {
      if(mode==='deny') return {deny:'held'};
      if(mode==='stay') return {stay:true};
      return next({element:'second'});
    });
  }`)
  const { value, statuses, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([policy, consumer])
  const pane = value.ui.getSnapshot()[0]!
  expect(pane).toMatchObject({ visible: true, focused: false })
  await value.dispatch('command.run', { command: 'focus', args: '', origin: { kind: 'composer' } }, async () => ({}))
  expect(statuses).toEqual([['ui-owner', JSON.stringify({ deny: 'site does not hold the keyboard' })]])
  expect(await value.ui.focus(pane.owner, {
    requestId: pane.id, element: 'first', origin: { kind: 'person' },
  }, wide)).toEqual({ focused: true, element: 'second' })
  expect(value.ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'second' })
  for (const [mode, result] of [['deny', { deny: 'held' }], ['stay', { stay: true }]] as const) {
    await value.dispatch('command.run', { command: 'mode', args: mode, origin: { kind: 'composer' } }, async () => ({}))
    expect(await value.ui.focus(pane.owner, {
      requestId: pane.id, element: 'first', origin: { kind: 'person' },
    }, wide)).toEqual({ ...result, focused: true, element: 'second' })
  }
  expect(diagnostics).toEqual([])
})

test('Worker wheel middleware receives body-relative pointers and consumes a virtual list without outer scrolling', async () => {
  const consumer = await plugin('ui-owner', `let row=0; export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'row:'+row}));
    on('ui.scroll', async ($,e,next) => {
      await $.ui.status(JSON.stringify(e));
      if(e.pointer.column>=10) return next(e);
      row=Math.max(0,row+e.by);
      await $.ui.invalidate('ui.render');
      return {};
    });
  }`)
  const { value, statuses, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const pane = value.ui.getSnapshot()[0]!
  await value.ui.reportMetrics(pane.id, { bodyRows: 4, contentRows: 4 })
  for (const [by, row] of [[3, 3], [-1, 2]] as const) {
    await value.ui.scroll(pane.owner, {
      requestId: pane.id, by, pointer: { column: 2, row: 1 }, origin: { kind: 'person' },
    })
    expect(value.ui.getSnapshot()[0]).toMatchObject({ focused: false, scrollOffset: 0 })
    expect((value.ui.getSnapshot()[0]!.tree as any).children).toEqual([`row:${row}`])
  }
  expect(statuses).toEqual([3, -1].map(by => ['ui-owner', JSON.stringify({
    component: 'Pane', requestId: 'panel', offset: 0, by, bodyRows: 4, contentRows: 4,
    origin: { kind: 'person' }, pointer: { column: 2, row: 1 },
  })]))
  await value.ui.reportMetrics(pane.id, { bodyRows: 4, contentRows: 12 })
  await value.ui.scroll(pane.owner, {
    requestId: pane.id, by: 3, pointer: { column: 12, row: 1 }, origin: { kind: 'person' },
  })
  expect(value.ui.getSnapshot()[0]!.scrollOffset).toBe(3)
  expect(diagnostics).toEqual([])
})

test('public focus and scroll wrappers project known fields before crossing the Worker bridge', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel',focus:true}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Button}=$.ui.resolve(e); return Box({children:[
      Button({key:'first',label:'First',onPress:()=>{}}),
      Button({key:'second',label:'Second',onPress:()=>{}}),
    ]}); });
    on('command.run', async ($) => {
      const focus=await $.ui.focus({requestId:'panel',key:'second',get ignored(){throw Error('unknown focus getter')}});
      let focusSync; try { $.ui.focus({get requestId(){throw Error('selected focus getter')},key:'second'}); } catch(error) { focusSync=error.message; }
      const scroll=await $.ui.scroll({to:'end',in:'panel',get ignored(){throw Error('unknown scroll getter')}});
      let scrollSync; try { $.ui.scroll({get to(){throw Error('selected scroll getter')},in:'panel'}); } catch(error) { scrollSync=error.message; }
      let focusHostSync='returned',focusHostAsync;
      try {
        const pending=$.ui.focus({requestId:'',key:'second'});
        try { await pending; } catch(error) { focusHostAsync=error.message; }
      } catch(error) { focusHostSync=error.message; }
      let scrollHostSync='returned',scrollHostAsync;
      try {
        const pending=$.ui.scroll({to:'end'});
        try { await pending; } catch(error) { scrollHostAsync=error.message; }
      } catch(error) { scrollHostSync=error.message; }
      const denied=await $.ui.focus({requestId:'missing',key:'second'});
      await $.ui.status(JSON.stringify({focus,focusSync,scroll,scrollSync,focusHostSync,focusHostAsync,scrollHostSync,scrollHostAsync,denied}));
      return {};
    });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])

  await value.dispatch('command.run',{command:'wrapper',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(value.ui.getSnapshot()[0]).toMatchObject({focusedElement:'second'})
  expect(statuses).toEqual([['ui-owner',JSON.stringify({
    focus:{},
    focusSync:'selected focus getter',
    scroll:{},
    scrollSync:'selected scroll getter',
    focusHostSync:'returned',
    focusHostAsync:'ui.focus takes { requestId, key }',
    scrollHostSync:'returned',
    scrollHostAsync:'ui.scroll takes { to, in?, block? }',
    denied:{deny:'site is not open'},
  })]])
  expect(diagnostics).toEqual([])
})

test('public ui.scroll resolves end and keyed targets before raising one plugin-origin scroll event', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Text}=$.ui.resolve(e); return Box({children:[Box({key:'target',children:[Text({children:'Target'})]})]}); });
    on('command.run', async ($,e) => {
      const args=e.args==='end' ? {to:'end',in:'panel'} : {to:{key:'target'},in:'panel',block:'center'};
      const result=await $.ui.scroll(args); await $.ui.status(JSON.stringify(result)); return {};
    });
  }`)
  const policy = await plugin('scroll-policy', `export function register(on) {
    on('ui.scroll', async ($,e,next) => { await $.ui.status(JSON.stringify(e)); return next(e); });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([policy,consumer])
  await value.ui.reportMetrics('panel', {
    bodyRows: 4,
    contentRows: 12,
    keyRows: [{plugin:'ui-owner',key:'target',top:6,bottom:7}],
  })

  await value.dispatch('command.run',{command:'scroll',args:'end',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))
  expect(value.ui.getSnapshot()[0]!.scrollOffset).toBe(8)
  await value.dispatch('command.run',{command:'scroll',args:'key',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(value.ui.getSnapshot()[0]!.scrollOffset).toBe(5)
  expect(statuses).toEqual([
    ['scroll-policy',JSON.stringify({component:'Pane',requestId:'panel',offset:8,by:8,bodyRows:4,contentRows:12,origin:{kind:'plugin',name:'ui-owner'}})],
    ['ui-owner','{}'],
    ['scroll-policy',JSON.stringify({component:'Pane',requestId:'panel',offset:5,by:-3,bodyRows:4,contentRows:12,origin:{kind:'plugin',name:'ui-owner'}})],
    ['ui-owner','{}'],
  ])
  expect(diagnostics).toEqual([])
})

test('public ui.scroll denies unsupported transcript targets without raising a pane scroll event', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'body'}));
    on('command.run', async ($,e) => {
      const result=await $.ui.scroll({to:{requestId:e.args}}); await $.ui.status(JSON.stringify(result)); return {};
    });
  }`)
  const policy = await plugin('scroll-policy', `export function register(on) {
    on('ui.scroll', async ($,e,next) => { await $.ui.status('unexpected scroll'); return next(e); });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([policy,consumer])

  await value.dispatch('command.run',{command:'scroll',args:'panel',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))
  await value.dispatch('command.run',{command:'scroll',args:'message-1',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(statuses).toEqual([
    ['ui-owner',JSON.stringify({deny:'nothing around that site scrolls'})],
    ['ui-owner',JSON.stringify({deny:'transcript not scrollable here'})],
  ])
  expect(diagnostics).toEqual([])
})

test('every actual render participant owns its callbacks, not just the pane opener', async () => {
  const decorator = await plugin('decorator', `export function register(on) { on('ui.render',async ($,e,next) => {const {Box,Button}=$.ui.resolve(e); return Box({children:[await next(e),Button({key:'decorate',label:'Decorate',onPress:() => $.ui.status('decorator pressed')})]}); }); }`)
  const consumer = await plugin('ui-owner', source('owner'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  const first = value.ui.getSnapshot()[0]!
  const tree = first.tree as any
  await value.ui.interact(first.id,first.drawing!,tree.children[1].press,'press','decorate')
  expect(statuses).toEqual([['decorator','decorator pressed']])
  await value.reconcile([])
  expect(value.ui.getSnapshot()).toEqual([])
  await expect(value.ui.interact(first.id,first.drawing!,tree.children[1].press,'press','decorate')).rejects.toThrow(/stale/)
  expect(diagnostics).toEqual([])
})

test('a render decorator can invalidate panes opened by another plugin', async () => {
  const decorator = await plugin('decorator', `export function register(on) {
    let count=0;
    on('ui.render',async ($,e,next) => {const {Box,Text}=$.ui.resolve(e); return Box({children:[await next(e),Text({children:'decorator:'+count})]});});
    on('command.run',async ($) => {count++;await $.ui.invalidate('ui.render');return {}});
  }`)
  const consumer = await plugin('ui-owner', source('owner'))
  const {value,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  const before = value.ui.getSnapshot()[0]!
  expect(JSON.stringify(before.tree)).toContain('decorator:0')

  await value.dispatch('command.run',{command:'refresh',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  const current = value.ui.getSnapshot()[0]!
  expect(current.drawing).not.toBe(before.drawing)
  expect(JSON.stringify(current.tree)).toContain('decorator:1')
  expect(diagnostics).toEqual([])
})

test('retirement closes panes even while an old runtime snapshot keeps the environment alive', async () => {
  const consumer = await plugin('ui-owner',source('old'))
  const {value,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const old = value.ui.getSnapshot()[0]!
  const lease = value.capture()
  try {
    await value.reconcile([])
    expect(value.ui.getSnapshot()).toEqual([])
    await expect(value.ui.interact(old.id,old.drawing!,(old.tree as any).children[1].press,'press','run')).rejects.toThrow(/stale/)
  } finally {lease.release()}
  expect(diagnostics).toEqual([])
})

test('reloading a render participant redraws a surviving pane with the new participant generation', async () => {
  const decoratorSource = (label: string) => `export function register(on) {on('ui.render',async ($,e,next) => {const {Box,Button}=$.ui.resolve(e); return Box({children:[await next(e),Button({key:'decorate',label:'${label}',onPress:() => $.ui.status('${label}')})]});});}`
  const decorator = await plugin('decorator',decoratorSource('old'))
  const consumer = await plugin('ui-owner',source('owner'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  const old = value.ui.getSnapshot()[0]!
  await writeFile(decorator.entrypoints[0]!,decoratorSource('new'))
  await value.reconcile([decorator,consumer])
  expect(diagnostics).toEqual([])
  const current = value.ui.getSnapshot()[0]!
  expect(current.drawing).not.toBe(old.drawing)
  await expect(value.ui.interact(old.id,old.drawing!,(old.tree as any).children[1].press,'press','decorate')).rejects.toThrow(/stale/)
  await value.ui.interact(current.id,current.drawing!,(current.tree as any).children[1].press,'press','decorate')
  expect(statuses).toContainEqual(['decorator','new'])
})

test('candidate close and invalidate cannot mutate the previous active drawing before rejected publication', async () => {
  const consumer = await plugin('ui-owner',source('old'))
  const blocker = await plugin('blocker',`export function register(on) {
    on('session.start',async($,e,next)=>{await $.command.register({name:'taken',description:'Blocker'});return next(e)});
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([blocker,consumer])
  const before = value.ui.getSnapshot()
  await writeFile(consumer.entrypoints[0]!,`export function register(on) {
    on('session.start',async ($,e,next) => {await $.ui.close({id:'panel'}); await $.ui.invalidate('ui.render'); await $.command.register({name:'taken',description:'Conflict'}); throw Error('candidate failed');});
    on('ui.render',($,e) => $.ui.resolve(e).Text({children:'wrong generation'}));
  }`)
  await value.reconcile([blocker,consumer])
  expect(value.ui.getSnapshot() === before).toBe(true)
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'ui-owner',message:expect.stringContaining('already owned')}))
  const pane = before[0]!
  await value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).children[1].press,'press','run')
  expect(statuses).toEqual([['ui-owner','old:1']])
})

test('a new subscriber can invoke the just-published drawing generation', async () => {
  const consumer = await plugin('ui-owner',source('new'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root))
  let pending: Promise<unknown> | undefined
  const unsubscribe = value.ui.subscribe(() => {
    const pane = value.ui.getSnapshot()[0]
    if (pane?.drawing && !pending) pending = value.ui.interact(pane.id,pane.drawing,(pane.tree as any).children[1].press,'press','run')
  })
  await value.reconcile([consumer]); unsubscribe()
  await pending
  expect(statuses).toContainEqual(['ui-owner','new:1'])
  expect(diagnostics).toEqual([])
})

test('ui.press rewrites never select a different plugin callback environment', async () => {
  const decorator = await plugin('decorator', `export function register(on) {
    on('ui.render',async ($,e,next) => {const {Box,Button}=$.ui.resolve(e); return Box({children:[await next(e),Button({key:'decorate',label:'Decorate',onPress:() => $.ui.status('right callback')})]}); });
    on('ui.press',($,e,next) => next({...e,plugin:'ui-owner'}));
  }`)
  const consumer = await plugin('ui-owner', source('owner'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  expect(diagnostics).toEqual([])
  const pane = value.ui.getSnapshot()[0]!
  expect((pane.tree as any).children[1].props.key).toBe('decorate')
  await value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).children[1].press,'press','decorate')
  expect(statuses).toEqual([['decorator','right callback']])
  expect(diagnostics).toEqual([])
})

test('ModsSession UI subscriptions are stable before runtime creation and notify on real activation', async () => {
  const consumer = await plugin('ui-owner',source('session'))
  const session = createModsSession({
    isTrusted:true,
    getSettings: () => ({userSettings:{},flagSettings:{},policySettings:{},hookPolicy:{managedOnly:false,allDisabled:false}}),
    loadPlugins: async () => [{name:consumer.name,source:consumer.storageId,path:consumer.pluginRoot,enabled:true,manifest:{name:consumer.name},repository:consumer.storageId,hookModules:[{configPath:join(consumer.pluginRoot,'hooks.json'),paths:consumer.entrypoints}]}] as any,
  })
  const empty = session.ui.getSnapshot()
  expect(session.ui.getSnapshot()).toBe(empty)
  let notifications = 0
  const unsubscribe = session.ui.subscribe(() => { notifications++ })
  try {
    await session.bind(binding(root),undefined,{uiPresentation:() => wide,uiStatus:() => {},uiLog:() => {}})
    expect(session.ui.getSnapshot()[0]?.title).toBe('session')
    const current = session.ui.getSnapshot()
    expect(session.ui.getSnapshot()).toBe(current)
    expect(notifications).toBeGreaterThan(0)
    await session.dispose()
    expect(session.ui.getSnapshot()).toEqual([])
  } finally { unsubscribe(); await session.dispose() }
})

test('REPL pane callbacks call the live UI host and keep independent dock/inline placement', async () => {
  const source = readFileSync(new URL('../../screens/REPL.tsx',import.meta.url),'utf8')
  const ast = ts.createSourceFile('REPL.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  let callback: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'renderModPane') callback = node.initializer
    ts.forEachChild(node,visit)
  }
  visit(ast)
  expect(callback).toBeDefined()
  const js = ts.transpileModule(`const extracted = ${callback!.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.None}}).outputText
  const calls: unknown[] = []
  const landing = {focused:true,element:'rewritten'}
  const ui = {
    interact:async (...args:unknown[]) => {calls.push(['interact',...args])},
    close:async (...args:unknown[]) => {calls.push(['close',...args])},
    focus:async (...args:unknown[]) => {calls.push(['focus',...args]); return landing},
    scroll:async (...args:unknown[]) => {calls.push(['scroll',...args])},
    reportMetrics:(...args:unknown[]) => {calls.push(['metrics',...args])},
    getSnapshot:() => [{...pane,revision:42}],
  }
  const pane = {id:'panel',plugin:'owner',owner:{},visible:true,focused:true,bodyRows:10,contentRows:20}
  const scope = {
    React:{createElement:(_type:unknown,props:unknown) => props}, ModsPane:'ModsPane',
    modPaneFocused:false, modUiPresentation:{...wide}, modUiPresentationRef:{current:{...wide}},
    modPanes:[pane], modsSession:{runtime:{ui}} as {runtime:{ui:typeof ui}} | undefined,
    logError:() => {},
  }
  const render = new Function('scope',`with(scope) {${js}; return extracted;}`)(scope)
  const props = render(pane)
  expect(props.pane.focused).toBe(false)
  expect(props.canFocus).toBe(true)
  scope.modPaneFocused = true
  expect(render(pane).pane).toBe(pane)

  const press = {plugin:'owner',handle:10}
  const pointer = {column:7,row:2}
  // An already-rendered callback must read the current presentation, not its render snapshot.
  const currentPresentation = {...wide,hasDialog:true,rows:27}
  scope.modUiPresentationRef.current = currentPresentation
  await props.onInteract(pane,1,press,'press','run')
  await props.onClose(pane)
  expect(await props.onFocus(pane,'run')).toEqual({...landing,revision:42})
  await props.onScroll(pane,3)
  await props.onScroll(pane,-1,pointer)
  props.onReportMetrics(pane,{bodyRows:10,contentRows:20})
  props.onReportMetrics(pane,{bodyRows:10,contentRows:20,keyRows:[{plugin:'owner',key:'run',top:1,bottom:2}]})
  props.onReportMetrics(pane,{bodyRows:10,contentRows:21,keyRows:[{plugin:'owner',key:'run',top:2,bottom:3}]})
  expect(calls).toEqual([
    ['interact','panel',1,press,'press','run',undefined],
    ['close',pane.owner,'panel',{kind:'person'}],
    ['focus',pane.owner,{requestId:'panel',element:'run',origin:{kind:'person'}},currentPresentation],
    ['scroll',pane.owner,{requestId:'panel',by:3,pointer:undefined,origin:{kind:'person'}}],
    ['scroll',pane.owner,{requestId:'panel',by:-1,pointer,origin:{kind:'person'}}],
    ['metrics','panel',{bodyRows:10,contentRows:20,keyRows:[{plugin:'owner',key:'run',top:1,bottom:2}]}],
    ['metrics','panel',{bodyRows:10,contentRows:21,keyRows:[{plugin:'owner',key:'run',top:2,bottom:3}]}],
  ])

  for (const changes of [{composerEmpty:false},{hasDialog:true},{keyboardOwned:true}]) {
    scope.modUiPresentation = {...wide,...changes}
    expect(render(pane).canFocus).toBe(false)
  }
  scope.modUiPresentation = {...wide}
  for (const other of [
    {...pane,id:'other',focused:false}, {...pane,id:'other',visible:false},
  ]) {
    scope.modPanes = [pane,other]
    expect(render(pane).canFocus).toBe(true)
  }
  scope.modPanes = [pane,{...pane,id:'other'}]
  expect(render(pane).canFocus).toBe(false)
  scope.modPanes = [pane]
  expect(render({...pane,focused:false}).canFocus).toBe(true)

  scope.modsSession = undefined
  expect(await props.onFocus(pane,'run')).toEqual({focused:false})
  await expect(props.onInteract(pane,1,press,'press','run')).rejects.toThrow('Mod UI host is unavailable')
  expect(calls).toHaveLength(7)
  expect(source).toContain('{modInline.map(renderModPane)}')
  expect(source).toContain('{modDock.map(renderModPane)}')
})

test('unsupported headless UI surface rejects open explicitly', async () => {
  const consumer = await plugin('ui-owner', source('headless'))
  const {value,diagnostics} = fixture({uiPresentation:undefined})
  await value.bind({...binding(root),surface:null,isInteractive:false}); await value.reconcile([consumer])
  expect(value.ui.getSnapshot()).toEqual([])
  expect(diagnostics).toContainEqual(expect.objectContaining({stage:'session.start',message:expect.stringMatching(/unsupported|unavailable|terminal/i)}))
})
