import {expect,test} from 'bun:test'
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import ts from 'typescript'
import {z} from 'zod/v4'
import {buildTool} from '../../Tool.js'
import {generateModDeclarationFiles} from './declarations.js'
import {runPluginTestFile} from './testing/runner.js'

function schemaTools(){
 const tool=buildTool({name:'FixtureRead',inputSchema:z.object({file_path:z.string()}),outputSchema:z.object({kind:z.literal('text'),text:z.string(),lines:z.array(z.number())}),maxResultSizeChars:1000,description:async()=> 'Read owned fixture',prompt:async()=> 'Read owned fixture',renderToolUseMessage:()=>null,call:async input=>({data:{kind:'text' as const,text:input.file_path,lines:[1]}}),mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:data.text})})
 return [tool,{...tool,name:'mcp__owned__read',isMcp:true}]
}
async function diagnostics(source:string){
 const root=await realpath(await mkdtemp(join(tmpdir(),'testing-event-declarations-')))
 try{
  const files=generateModDeclarationFiles('2.1.289',schemaTools())
  for(const file of files){await mkdir(dirname(join(root,file.path)),{recursive:true});await writeFile(join(root,file.path),file.text)}
  const author=join(root,'author.ts');await writeFile(author,source)
  const config=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'))
  config.compilerOptions={...config.compilerOptions,skipLibCheck:false,incremental:false}
  config.files=[...files.filter(file=>file.path.endsWith('.d.ts')).map(file=>file.path),'author.ts'];delete config.include
  const parsed=ts.parseJsonConfigFileContent(config,ts.sys,root)
  const program=ts.createProgram(parsed.fileNames,parsed.options)
  const refs=program.getSourceFiles().map(file=>file.fileName)
  for(const name of config.files.slice(0,-1))expect(refs).toContain(join(root,name))
  expect(config.files.slice(0,-1)).toEqual(['claude-code/index.d.ts','claude-code-tools/index.d.ts','claude-code-mcp/index.d.ts'])
  expect(parsed.options.skipLibCheck).toBe(false)
  return [...parsed.errors,...ts.getPreEmitDiagnostics(program)].map(item=>{const pos=item.file?.getLineAndCharacterOfPosition(item.start??0);return {file:item.file?.fileName===author?'author.ts':item.file?.fileName,line:pos?pos.line+1:undefined,code:item.code,message:ts.flattenDiagnosticMessageText(item.messageText,'\n')}})
 }finally{await rm(root,{recursive:true,force:true})}
}

const positive=`import type {On,Register,Args,EventOf,ResultOf,EventCalls,SessionStartInput,SessionStartResult,SessionCompactInput,SessionCompactArgs,SessionCompactResult,SessionAttachInput,SessionAttachResult,SessionDetachInput,SessionDetachResult,SessionMeasureInput,SessionMeasureResult,SessionEndInput,SessionEndResult} from 'claude-code'
import type {Engine} from 'claude-code/testing'
import type {SessionContextBreakdown} from 'claude-code'
declare const on:On,$:Engine,calls:EventCalls
declare const start:SessionStartInput,compact:SessionCompactInput,attach:SessionAttachInput,detach:SessionDetachInput,measure:SessionMeasureInput,end:SessionEndInput
const a:Promise<SessionStartResult>=$.session.start(start)
const b:Promise<SessionCompactResult>=$.session.compact(compact)
const c:Promise<SessionAttachResult>=$.session.attach(attach)
const d:Promise<SessionDetachResult>=$.session.detach(detach)
const e:Promise<SessionMeasureResult>=$.session.measure(measure)
const f:Promise<SessionEndResult>=$.session.end(end)
const core:Args<'session.end'>=end
const same:EventOf['session.end']=core
declare const receipt:ResultOf['session.end']
const expected:SessionEndResult=receipt
const publicArgs:SessionCompactArgs={instructions:'keep the plan'}
const publicCompact:Promise<SessionCompactResult>=calls.session.compact(publicArgs)
const publicDefault:Promise<SessionCompactResult>=calls.session.compact()
on('session.start',async($,e,next)=>{const cwd:string=e.cwd;const interactive:boolean=e.isInteractive;return next(e)})
on('session.compact',async($,e,next)=>{const trigger:'manual'|'auto'|'plugin'|'precompute'=e.trigger;const r=await next(e);if(r.skip===undefined){const messages:readonly unknown[]=r.messages}else{const reason:string=r.skip}return r})
on('session.attach',($,e,next)=>{const client:string=e.clientId;const columns:number|undefined=e.viewport?.columns;return next(e)})
on('session.detach',($,e,next)=>{const reason:'detach'|'end'=e.reason;return next(e)})
on('session.measure',($,e,next)=>{const window:number=e.context.window;const units:('context'|'rateLimits'|'cost')[]=e.changed;e.changed.push('cost');return next(e)})
on('session.end',($,e,next)=>{const id:string=e.resume.id;const remaining:number=next.budget.remainingMs;return next(e)})
export const concise:Register=on=>on('session.start',($,e,next)=>next(e))
export const asynchronous:Register=async on=>on('session.start',($,e,next)=>next(e))
export const ignoredValue:Register=on=>{on('session.start',($,e,next)=>next(e));return 123}
declare const breakdown:SessionContextBreakdown
breakdown.categories.push({name:'owned',tokens:1,color:'red',isDeferred:false,kind:'used'})
breakdown.gridRows.push([])
breakdown.memoryFiles.push({path:'/owned',type:'Project',tokens:1})
breakdown.apiUsage=null
`
const negative=`import type {On} from 'claude-code'
import type {Engine} from 'claude-code/testing'
declare const on:On,$:Engine
$.session.start({cwd:4,surface:'terminal',isInteractive:true}) // NEGATIVE: cwd
$.session.start() // NEGATIVE: whole start input
$.session.compact({instructions:'owned'}) // NEGATIVE: whole engine compaction input
$.session.compact({trigger:'manual',messages:[],agentId:4}) // NEGATIVE: engine agent id
$.session.attach({surface:'terminal',clientId:'owned',viewport:{columns:'wide',rows:20}}) // NEGATIVE: viewport columns
$.session.detach({surface:'terminal',clientId:'owned',reason:'lost'}) // NEGATIVE: detach reason
$.session.measure({context:{window:20},rateLimits:[],changed:['tokens']}) // NEGATIVE: changed units
$.session.end({reason:'other',sessionId:'owned',resume:{id:4}}) // NEGATIVE: resume id
on('session.start',()=>({cwd:4})) // NEGATIVE: start receipt
on('session.start',()=>undefined) // NEGATIVE: hook still needs a receipt when registration result is ignored
on('session.start',async()=>undefined) // NEGATIVE: async hook still needs a receipt
on('session.compact',()=>({skip:4})) // NEGATIVE: skip receipt
on('session.compact',()=>({messages:[],skip:'both'})) // NEGATIVE: exclusive compaction result
on('session.attach',()=>({clientId:4})) // NEGATIVE: attach receipt
on('session.detach',()=>({clientId:4})) // NEGATIVE: detach receipt
on('session.measure',()=>({changed:['tokens']})) // NEGATIVE: changed receipt
on('session.end',()=>({sessionId:4})) // NEGATIVE: end receipt
on('session.start',($,e,next)=>{e.cwd='changed';return next(e)}) // NEGATIVE: frozen field
on('session.measure',($,e,next)=>{e.context.window=4;return next(e)}) // NEGATIVE: frozen nested field
on('session.end',($,e,next)=>{e.resume.id='changed';return next(e)}) // NEGATIVE: frozen resume
`

test('six existing session event consumers expose exact inputs and results through all generated references',async()=>{
 expect(await diagnostics(positive)).toEqual([])
})
test('session event types reject every invalid input, result and frozen rewrite without unrelated diagnostics',async()=>{
 const observed=await diagnostics(negative)
 const lines=negative.split('\n').flatMap((line,index)=>line.includes('// NEGATIVE:')?[index+1]:[])
 for(const line of lines)expect(observed.some(item=>item.file==='author.ts'&&item.line===line)).toBe(true)
 expect(observed.every(item=>item.file==='author.ts'&&lines.includes(item.line!))).toBe(true)
})
test('session event consumers remain event calls rather than newly exposed production capabilities',async()=>{
 const observed=await diagnostics(`import type {EngineInterface} from 'claude-code';declare const $:EngineInterface
 $.session.start({cwd:'/owned',surface:null,isInteractive:false})
 $.session.attach({surface:'terminal',clientId:'owned'})
 $.session.detach({surface:'terminal',clientId:'owned',reason:'detach'})
 $.session.measure({context:{window:20},rateLimits:[],changed:['context']})
 $.session.end({reason:'other',sessionId:'owned',resume:{id:'owned'}})
 `)
 expect(observed).toHaveLength(5)
 // The canonical session.send entry makes TypeScript suggest it for the still
 // unpublished end call (2551); the other four absent methods produce 2339.
 expect(observed.map(({file,line,code})=>({file,line,code}))).toEqual([2,3,4,5,6].map((line,index)=>({file:'author.ts',line,code:index===4?2551:2339})))
})
test('typed session event calls enter the actual author runner and preserve their receipt shapes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'session-event-author-')),file=join(root,'session.test.ts')
 try{
  await mkdir(join(root,'.claude-plugin'));await mkdir(join(root,'hooks'))
  await writeFile(join(root,'.claude-plugin/plugin.json'),JSON.stringify({name:'session-event-types',version:'1.0.0'}))
  await writeFile(join(root,'hooks/hooks.json'),JSON.stringify({modules:['../register.ts']}))
  await writeFile(join(root,'register.ts'),'export function register(on) {}')
  await writeFile(file,`import {test,expect} from 'claude-code/testing';test('session events',async($,on)=>{
   on('session.start',($,e)=>({cwd:e.cwd}));
   on('session.compact',()=>({skip:'owned'}));
   on('session.attach',($,e)=>({clientId:e.clientId}));
   on('session.detach',($,e)=>({clientId:e.clientId}));
   on('session.measure',($,e)=>({changed:e.changed}));
   on('session.end',($,e)=>({sessionId:e.sessionId}));
   expect(await $.session.start({cwd:'/owned',surface:null,isInteractive:false})).toEqual({cwd:'/owned'});
   expect(await $.session.compact({trigger:'plugin',messages:[]})).toEqual({skip:'owned'});
   expect(await $.session.attach({surface:'terminal',clientId:'owned',viewport:{columns:80,rows:24}})).toEqual({clientId:'owned'});
   expect(await $.session.detach({surface:'terminal',clientId:'owned',reason:'detach'})).toEqual({clientId:'owned'});
   expect(await $.session.measure({context:{window:200000},rateLimits:[],changed:['context']})).toEqual({changed:['context']});
   expect(await $.session.end({reason:'other',sessionId:'owned',resume:{id:'owned'}})).toEqual({sessionId:'owned'});
  })`)
  const result=await runPluginTestFile(root,file)
  expect(result.loadFailure).toBeUndefined()
  expect(result.tests).toHaveLength(1)
  expect(result.tests[0]!.failure).toBeUndefined()
 }finally{await rm(root,{recursive:true,force:true})}
})
