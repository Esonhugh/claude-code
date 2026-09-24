import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime>
const diagnostics: unknown[] = []
const statuses: unknown[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-render-consumer-'))
  diagnostics.length = 0
  statuses.length = 0
  runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: { uiStatus: (plugin, text) => { statuses.push([plugin, text]) } },
  })
})
afterEach(async () => {
  await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})
async function load(source: string) {
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  await runtime.reconcile([{ name: 'render-ui', storageId: 'render-ui@test', pluginRoot: root, entrypoints: [entry] }])
}

test('blits a mounted non-Pane Raster without rerunning ui.render or changing its drawing lease', async () => {
  const cell = (character: string) => {
    const bytes = Buffer.alloc(12)
    bytes.writeUInt32LE(character.charCodeAt(0), 0)
    bytes.writeUInt32LE(0x01000000, 4)
    bytes.writeUInt32LE(0x01000000, 8)
    return bytes.toString('base64')
  }
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'blit-test'})
  await load(`let draws=0;export function register(on){
    on('ui.render',($,e)=>{draws++;return $.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cell('A')}'})});
    on('command.run',async($)=>{const result=await $.ui.blit({requestId:'hint',key:'pixels',cells:'${cell('B')}'});await $.ui.status(JSON.stringify({result,draws}));return {}});
  }`)
  const frames: Array<{tree:any;drawing:number}>=[]
  const site=await runtime.ui.mount({surface:'terminal',component:'PromptHint',requestId:'hint',props:{}},{
    surface:'terminal',render:(tree,drawing)=>{frames.push({tree,drawing})},unmount:()=>{},
  })
  await runtime.dispatch('command.run',{command:'blit',args:'',origin:{kind:'composer'}},async()=>({}))
  expect(frames).toHaveLength(2)
  expect(frames[1]!.drawing).toBe(frames[0]!.drawing)
  expect(frames[1]!.tree.props.cells).toBe(cell('B'))
  expect(statuses).toEqual([['render-ui',JSON.stringify({result:{},draws:1})]])
  await site.dispose()
})

test('injected desktop consumer renders a non-Pane Worker tree and owns its drawing callbacks', async () => {
  await runtime.bind({ cwd: root, surface: 'desktop', isInteractive: true, sessionId: 'desktop-test' })
  await load(`export function register(on) {
    on('ui.render', {component:'PromptHint'}, ($,e,next) => {
      if (e.surface !== 'desktop') return next(e);
      const {Box,Text,Button,Markdown}=$.ui.resolve(e);
      return Box({children:[Text({children:e.surface+':'+e.component+':'+e.props.text}),
        Markdown({text:'**desktop markdown**'}),
        Button({key:'run',label:'Desktop action',onPress:()=>$.ui.status('desktop pressed')})]});
    });
  }`)
  let painted = ''
  let button: any
  let drawing = 0
  // Interpret the tree as a fake remote client, rather than only inspecting data.
  const draw = (tree: any): string => {
    if (typeof tree === 'string') return tree
    if (tree.type === 'Markdown') return tree.props.text.replaceAll('**','')
    if (tree.type === 'Button') { button=tree; return '['+tree.props.label+']' }
    return (tree.children ?? []).map(draw).join(' ')
  }
  const site = await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{text:'ready'},viewport:{columns:90,rows:30}}, {
    surface:'desktop', render: (tree, lease) => {painted=draw(tree);drawing=lease}, unmount: () => {painted=''},
  })
  try {
    expect(diagnostics).toEqual([])
    expect(painted).toBe('desktop:PromptHint:ready desktop markdown [Desktop action]')
    await site.interact(drawing,button.press,'press','run')
    expect(statuses).toEqual([['render-ui','desktop pressed']])
    expect(runtime.ui.getSnapshot()).toEqual([])
  } finally { await site.dispose() }
  expect(painted).toBe('')
  await expect(site.interact(drawing,button.press,'press','run')).rejects.toThrow(/stale/)
})

test('remote consumer recursively freezes children beneath an already frozen node', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'desktop-freeze'})
  await load(`export function register(on) {
    on('ui.render',($,e) => {
      const child = {type:'Text',props:{color:'blue'},children:['ready']};
      return Object.freeze({type:'Box',props:{},children:[child]});
    });
  }`)
  let frame: any
  const site = await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'freeze',props:{}}, {
    surface:'desktop', render:tree=>{frame=tree}, unmount:()=>{},
  })
  try {
    expect(diagnostics).toEqual([])
    expect(Object.isFrozen(frame)).toBe(true)
    expect(Object.isFrozen(frame.children)).toBe(true)
    expect(Object.isFrozen(frame.children[0])).toBe(true)
    expect(Object.isFrozen(frame.children[0].props)).toBe(true)
  } finally { await site.dispose() }
})

test.each(['desktop', 'mobile', 'vscode'] as const)('remote %s consumer receives a frozen Svg drawing unchanged from the Worker', async surface => {
  await runtime.bind({cwd:root,surface,isInteractive:true,sessionId:`${surface}-svg`})
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><path d="M0 0h2v1H0z"/></svg>'
  await load(`export function register(on) {
    on('ui.render',($,e)=>$.ui.resolve(e).Svg({source:${JSON.stringify(source)},alt:'status graph',width:240,height:120,isInteractive:true}));
  }`)
  const frames: Array<{tree:any;drawing:number}> = []
  const site = await runtime.ui.mount({surface,component:'PromptHint',requestId:'svg',props:{}}, {
    surface,
    render:(tree,drawing)=>{frames.push({tree,drawing})},
    unmount:()=>{},
  })
  try {
    expect(diagnostics).toEqual([])
    expect(frames).toHaveLength(1)
    expect(frames[0]!.tree).toEqual({
      type:'Svg',
      props:{source,alt:'status graph',width:240,height:120,isInteractive:true},
    })
    expect(Object.isFrozen(frames[0]!.tree)).toBe(true)
    expect(Object.isFrozen(frames[0]!.tree.props)).toBe(true)
    expect(JSON.parse(JSON.stringify(frames[0]!.tree))).toEqual(frames[0]!.tree)
  } finally { await site.dispose() }
})

test.each(['desktop', 'mobile', 'vscode'] as const)('remote %s rejects a forged Svg with active content before painting', async surface => {
  await runtime.bind({cwd:root,surface,isInteractive:true,sessionId:`${surface}-unsafe-svg`})
  await load(`export function register(on) {
    on('ui.render',()=>({type:'Svg',props:{source:'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',alt:'unsafe'}}));
  }`)
  const frames: any[] = []
  const site = await runtime.ui.mount({surface,component:'PromptHint',requestId:'svg',props:{text:'engine fallback'}}, {
    surface,
    render:(tree:any,_drawing,resolveEngine)=>{frames.push(tree.type === 'engine' ? resolveEngine(tree.ref).text : tree)},
    unmount:()=>{},
  })
  try {
    expect(frames).toEqual(['engine fallback'])
    expect(diagnostics).toContainEqual(expect.objectContaining({stage:'ui.render',message:expect.stringContaining('active content')}))
  } finally { await site.dispose() }
})

test('terminal has no Svg constructor and falls back before its consumer paints a forged Svg', async () => {
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'terminal-svg'})
  await load(`export function register(on) {
    on('ui.render',($,e)=>{
      const elements=$.ui.resolve(e);
      if ('Svg' in elements) return elements.Svg({source:'<svg></svg>',alt:'bad'});
      return {type:'Svg',props:{source:'<svg></svg>',alt:'forged'}};
    });
  }`)
  const frames: any[] = []
  const site = await runtime.ui.mount({surface:'terminal',component:'PromptHint',requestId:'svg',props:{text:'engine fallback'}}, {
    surface:'terminal',
    render:(tree:any,_drawing,resolveEngine)=>{frames.push(tree.type === 'engine' ? resolveEngine(tree.ref).text : tree)},
    unmount:()=>{},
  })
  try {
    expect(frames).toEqual(['engine fallback'])
    expect(diagnostics).toContainEqual(expect.objectContaining({stage:'ui.render',message:expect.stringContaining('Svg')}))
  } finally { await site.dispose() }
})

test('engine refs retain each continuation props and the original drawing for the consumer', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'engine-test'})
  await load(`export function register(on) {
    on('ui.render',async($,e,next)=>{
      const a=await next({...e,props:{...e.props,text:'rewritten'}});
      const b=await next({...e,props:{...e.props,text:'second'}});
      return $.ui.resolve(e).Box({children:[{type:'engine',ref:0},a,b]});
    });
  }`)
  let painted=''
  let resolveOld: (ref:number)=>Record<string,unknown>
  const input={surface:'desktop' as const,component:'UserMessage' as const,requestId:'message',props:{text:'original'}}
  const site=await runtime.ui.mount(input,{
    surface:'desktop',render:(tree:any,_drawing,resolveEngine)=>{
      resolveOld ??= resolveEngine
      painted=tree.children.map((node:any)=>resolveEngine(node.ref).text).join('|')
    },unmount:()=>{},
  })
  try {
    expect(painted).toBe('original|rewritten|second')
    await site.update({...input,props:{text:'updated'}})
    expect(painted).toBe('updated|rewritten|second')
    expect(()=>resolveOld(0)).toThrow(/stale/)
    expect(diagnostics).toEqual([])
  } finally {await site.dispose()}
})

test('Markdown onLinkPress stays private and receives the exact pressed href through ui.press', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'markdown-link'})
  await load(`export function register(on) {
    on('ui.render',($,e)=>$.ui.resolve(e).Markdown({key:'docs',text:'[Docs](https://example.com/docs)',onLinkPress:(link,event)=>$.ui.status(JSON.stringify({link,event}))}));
  }`)
  let tree:any
  let drawing=0
  const site=await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{}},{
    surface:'desktop',render:(next,lease)=>{tree=next;drawing=lease},unmount:()=>{},
  })
  try {
    expect(tree.props).not.toHaveProperty('onLinkPress')
    await site.interact(drawing,tree.press,'link.press','docs','https://example.com/docs')
    expect(statuses).toEqual([['render-ui',JSON.stringify({
      link:{href:'https://example.com/docs'},
      event:{surface:'desktop',component:'PromptHint',requestId:'hint',plugin:'render-ui',element:'docs',link:{href:'https://example.com/docs'}},
    })]])
  } finally {await site.dispose()}
})

test('a forged engine ref is rejected before the consumer resolves a drawing', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'forged-ref'})
  await load(`export function register(on) {
    on('ui.render', () => ({type:'engine',ref:999}));
  }`)
  const frames: unknown[] = []
  const site = await runtime.ui.mount({surface:'desktop',component:'UserMessage',requestId:'message',props:{text:'core fallback'}}, {
    surface:'desktop', render:(tree:any,_drawing,resolveEngine)=>{frames.push(resolveEngine(tree.ref).text)}, unmount:()=>{},
  })
  try {
    expect(frames).toEqual(['core fallback'])
    expect(diagnostics).toContainEqual(expect.objectContaining({stage:'ui.render',message:expect.stringContaining('engine ref')}))
  } finally { await site.dispose() }
})

test.each([
  ['oversized text', `$.ui.resolve(e).Markdown({text:'x'.repeat(10001)})`],
  ['control characters', `$.ui.resolve(e).Markdown({text:String.fromCharCode(27)+'[31m'})`],
  ['leaf children', `({type:'Markdown',props:{text:'ok'},children:['unexpected']})`],
  ['link callback without key', `$.ui.resolve(e).Markdown({text:'[link](https://example.com)',onLinkPress:()=>{}})`],
])('invalid Markdown %s falls back before the consumer paints it', async (_name, source) => {
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'invalid-markdown'})
  await load(`export function register(on) {on('ui.render', ($,e)=>${source})}`)
  const painted: unknown[] = []
  const site = await runtime.ui.mount({surface:'terminal',component:'PromptHint',requestId:'hint',props:{text:'engine fallback'}}, {
    surface:'terminal', render:(tree:any,_drawing,resolveEngine)=>{painted.push(resolveEngine(tree.ref).text)}, unmount:()=>{},
  })
  try {
    expect(painted).toEqual(['engine fallback'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({plugin:'render-ui',stage:'ui.render'})
  } finally { await site.dispose() }
})

test('mobile consumer rejects an Input from another surface before it is painted', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'mobile-test'})
  await load(`export function register(on) {
    on('ui.render',($,e)=>$.ui.resolve({surface:'desktop',component:e.component}).Input({key:'input',onSubmit:()=>{}}));
  }`)
  const types:string[]=[]
  const site=await runtime.ui.mount({surface:'mobile',component:'AbovePrompt',requestId:'mobile',props:{}},{surface:'mobile',render:(tree:any)=>{types.push(tree.type)},unmount:()=>{}})
  try {
    expect(types).toEqual(['engine'])
    expect(diagnostics).toContainEqual(expect.objectContaining({stage:'ui.render',message:expect.stringContaining('mobile')}))
  } finally {await site.dispose()}
})

test('consumer reload redraws against the new hook generation without stale closures', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'reload-test'})
  const source=(label:string)=>`export function register(on) {on('ui.render',($,e)=>$.ui.resolve(e).Button({key:'run',label:'${label}',onPress:()=>$.ui.status('${label}')}))}`
  await load(source('old'))
  const frames:any[]=[]
  const site=await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{}},{surface:'desktop',render:(tree,drawing)=>{frames.push({...tree as object,drawing})},unmount:()=>{}})
  try {
    const old=frames[0]
    await load(source('new'))
    expect(frames.at(-1).props.label).toBe('new')
    await expect(site.interact(old.drawing,old.press,'press','run')).rejects.toThrow(/stale/)
    await site.interact(frames.at(-1).drawing,frames.at(-1).press,'press','run')
    expect(statuses).toContainEqual(['render-ui','new'])
    expect(diagnostics).toEqual([])
  } finally {await site.dispose()}
})

test('unloading the last render hook restores the engine consumer and revokes plugin callbacks', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'unload-render-hook'})
  await load(`export function register(on) {
    on('ui.render', ($,e) => $.ui.resolve(e).Button({key:'run',label:'plugin',onPress:()=>$.ui.status('pressed')}));
  }`)
  const frames: {text:string;tree:any;drawing:number}[] = []
  const site = await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{text:'engine'}}, {
    surface:'desktop', render:(tree:any,drawing,resolveEngine)=>{
      frames.push({tree,drawing,text:tree.type === 'engine' ? String(resolveEngine(tree.ref).text) : tree.props.label})
    }, unmount:()=>{},
  })
  try {
    const old = frames[0]!
    await runtime.reconcile([])
    expect(frames.map(frame=>frame.text)).toEqual(['plugin','engine'])
    await expect(site.interact(old.drawing,old.tree.press,'press','run')).rejects.toThrow(/stale/)
    expect(statuses).toEqual([])
    expect(diagnostics).toEqual([])
  } finally { await site.dispose() }
})

test('loading the first render hook redraws a mounted engine-only consumer', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'late-render-hook'})
  const frames: string[] = []
  const site = await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{text:'engine'}}, {
    surface:'desktop',
    render: (tree: any, _drawing, resolveEngine) => {
      frames.push(tree.type === 'engine' ? String(resolveEngine(tree.ref).text) : tree.children.join(''))
    },
    unmount: () => {},
  })
  try {
    expect(frames).toEqual(['engine'])
    await load(`export function register(on) {
      on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'plugin'}));
    }`)
    expect(frames).toEqual(['engine', 'plugin'])
    expect(diagnostics).toEqual([])
  } finally { await site.dispose() }
})

test('consumer updates preserve viewport semantics and recover after a failed paint', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'viewport-test'})
  await load(`let count=0; export function register(on) {
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:JSON.stringify({count:++count,...e.viewport,text:e.props.text})}));
  }`)
  const frames: any[]=[]
  let fail=false
  let unmounts=0
  const initial={surface:'desktop' as const,component:'UserMessage' as const,requestId:'message',props:{text:'one'},viewport:{columns:90,rows:30}}
  const site=await runtime.ui.mount(initial,{surface:'desktop',render:tree=>{if(fail) throw Error('paint failed');frames.push(tree)},unmount:()=>{unmounts++}})
  const last=()=>JSON.parse(frames.at(-1).children[0])
  expect(last()).toEqual({count:1,columns:90,rows:30,text:'one'})
  await site.update({...initial,viewport:{columns:90,rows:50}})
  expect(frames).toHaveLength(1)
  await site.update({...initial,viewport:{columns:91,rows:50,isFullscreen:false}})
  expect(last()).toEqual({count:2,columns:91,rows:50,isFullscreen:false,text:'one'})
  fail=true
  // Bun 1.3.14 .rejects stalls this Worker path; await it before asserting the error.
  const failedPaint = await site.update({...initial,props:{text:'two'}}).then(
    () => undefined,
    error => error,
  )
  expect(failedPaint).toBeInstanceOf(Error)
  expect(failedPaint.message).toBe('paint failed')
  expect(frames).toHaveLength(2)
  fail=false
  await site.update({...initial,props:{text:'two'}})
  expect(diagnostics).toEqual([])
  expect(last()).toEqual({count:4,columns:90,rows:30,text:'two'})
  await expect(site.update({...initial,surface:'terminal'})).rejects.toThrow(/surface/)
  await runtime.dispose()
  expect(unmounts).toBe(1)
  await expect(site.update(initial)).rejects.toThrow(/stale/)
  expect(diagnostics).toEqual([])
})

test('failed paints revoke candidate callbacks and refs while preserving the displayed drawing', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'failed-paint-leases'})
  await load(`export function register(on) {
    on('ui.render',($,e)=>$.ui.resolve(e).Button({key:'run',label:e.props.text,onPress:()=>$.ui.status(e.props.text)}));
  }`)
  const frames: {tree:any;drawing:number;resolve:(ref:number)=>Record<string,unknown>}[] = []
  let fail = false
  const input = {surface:'desktop' as const,component:'PromptHint' as const,requestId:'hint',props:{text:'old'}}
  const site = await runtime.ui.mount(input, {
    surface:'desktop', render:(tree,drawing,resolve)=>{
      frames.push({tree,drawing,resolve})
      if (fail) throw new Error('candidate paint failed')
    }, unmount:()=>{},
  })
  try {
    fail = true
    const failure = await site.update({...input,props:{text:'failed'}}).then(()=>undefined,error=>error)
    expect(failure?.message).toBe('candidate paint failed')
    const [old, candidate] = frames
    expect(candidate!.resolve.bind(null, 0)).toThrow(/stale/)
    expect(old!.resolve(0)).toEqual({text:'old'})
    await expect(site.interact(candidate!.drawing,candidate!.tree.press,'press','run')).rejects.toThrow(/stale/)
    await site.interact(old!.drawing,old!.tree.press,'press','run')
    expect(statuses).toEqual([['render-ui','old']])
    fail = false
    await site.update({...input,props:{text:'new'}})
    expect(old!.resolve.bind(null, 0)).toThrow(/stale/)
    const latest = frames.at(-1)!
    await site.interact(latest.drawing,latest.tree.press,'press','run')
    expect(statuses).toEqual([['render-ui','old'],['render-ui','new']])
    expect(diagnostics).toEqual([])
  } finally { await site.dispose() }
})

test('a queued redraw uses the props of the latest completed consumer update', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'queued-redraw'})
  await load(`export function register(on) {
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:e.props.text}));
  }`)
  const frames: string[] = []
  const painting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const input = {surface:'desktop' as const,component:'PromptHint' as const,requestId:'hint',props:{text:'one'}}
  const site = await runtime.ui.mount(input, {
    surface:'desktop', render:async (tree:any)=>{
      if (frames.length === 1) { painting.resolve(); await release.promise }
      frames.push(tree.children.join(''))
    }, unmount:()=>{},
  })
  try {
    const update = site.update({...input,props:{text:'two'}})
    await painting.promise
    const redraw = runtime.ui.render()
    release.resolve()
    await Promise.all([update, redraw])
    expect(frames).toEqual(['one', 'two', 'two'])
    expect(diagnostics).toEqual([])
  } finally { release.resolve(); await site.dispose() }
})

test('a redraw during the first consumer paint is queued rather than lost', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'initial-paint-redraw'})
  await load(`let count=0; export function register(on) {
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:String(++count)}));
  }`)
  const frames: string[] = []
  const painting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const mounting = runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{}}, {
    surface:'desktop', render:async (tree:any)=>{
      if (!frames.length) { painting.resolve(); await release.promise }
      frames.push(tree.children.join(''))
    }, unmount:()=>{},
  })
  try {
    await painting.promise
    const redraw = runtime.ui.render()
    release.resolve()
    const site = await mounting
    await redraw
    expect(frames).toEqual(['1', '2'])
    expect(diagnostics).toEqual([])
    await site.dispose()
  } finally { release.resolve(); await (await mounting).dispose() }
})

test('concurrent site disposals wait for the same consumer unmount', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'concurrent-disposal'})
  const unmounting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let unmounts = 0
  const site = await runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{}}, {
    surface:'desktop', render:()=>{}, unmount:async()=>{unmounts++;unmounting.resolve();await release.promise},
  })
  const first = site.dispose()
  try {
    await unmounting.promise
    let finished = false
    const second = site.dispose().then(()=>{finished=true})
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    release.resolve()
    await Promise.all([first, second])
    expect(unmounts).toBe(1)
  } finally { release.resolve(); await first }
})

test('runtime disposal prevents new render sites from painting', async () => {
  await runtime.bind({cwd:root,surface:'desktop',isInteractive:true,sessionId:'disposed-render'})
  await runtime.dispose()
  let paints = 0
  await expect(runtime.ui.mount({surface:'desktop',component:'PromptHint',requestId:'hint',props:{}}, {
    surface:'desktop', render:()=>{paints++}, unmount:()=>{},
  })).rejects.toThrow(/disposed|stale/)
  expect(paints).toBe(0)
})

test('surface invalidation redraws the mounted consumer and releases the superseded callback', async () => {
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'render-lifecycle'})
  await load(`let count=0; export function register(on) {
    on('ui.render', ($,e) => $.ui.resolve(e).Button({key:'count',label:String(count),onPress:async()=>{count++;await $.ui.invalidate('ui.render')}}));
  }`)
  const frames: any[]=[]
  const site=await runtime.ui.mount({surface:'desktop',component:'AbovePrompt',requestId:'counter',props:{}}, {
    surface:'desktop',render:(tree,drawing)=>{frames.push({...tree as object,drawing})},unmount:()=>{},
  })
  try {
    const old=frames[0]
    await site.interact(old.drawing,old.press,'press','count')
    expect(frames.map(tree=>tree.props.label)).toEqual(['0','1'])
    await expect(site.interact(old.drawing,old.press,'press','count')).rejects.toThrow(/stale/)
    expect(diagnostics).toEqual([])
  } finally {await site.dispose()}
})
