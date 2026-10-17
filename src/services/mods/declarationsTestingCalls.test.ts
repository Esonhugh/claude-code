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

test('testing submit and tool events retain precise whole-event input and raw results in complete strict declarations',async()=>{
 const output=await diagnostics(`import type {PromptSubmitInput,PromptSubmitResult,ToolCheckResult,ToolCallResult} from 'claude-code'
import type {Engine} from 'claude-code/testing'
declare const $:Engine
declare const input:PromptSubmitInput
const submit:Promise<PromptSubmitResult>=$.prompt.submit(input)
const check:Promise<ToolCheckResult>=$.tool.check({tool:'FixtureRead',input:{file_path:'/owned/file'},tool_use_id:'owned'})
const call:Promise<ToolCallResult<'FixtureRead'>>=$.tool.call({tool:'FixtureRead',file_path:'/owned/file'})
async function reads(){const r=await call;if(r.deny===undefined&&r.isError!==true){const text:string=r.result.text;return text}}
void [submit,check,call,reads]`)
 expect(output).toEqual([])
})

test('testing rejects incorrect prompt text, event ID and generated tool input at exact lines',async()=>{
 const output=await diagnostics(`import type {PromptSubmitInput} from 'claude-code'
import type {Engine} from 'claude-code/testing'
declare const $:Engine
declare const input:PromptSubmitInput
$.prompt.submit({...input,text:1})
$.tool.check({tool:'FixtureRead',input:{file_path:'/owned/file'},tool_use_id:1})
$.tool.call({tool:'FixtureRead',file_path:1})`)
 expect(output.map(({file,line,code})=>({file,line,code}))).toEqual([{file:'author.ts',line:5,code:2322},{file:'author.ts',line:6,code:2322},{file:'author.ts',line:7,code:2769}])
})

test('testing keeps outputSchema and MCP result precision without adding unpublished prompt edit',async()=>{
 const output=await diagnostics(`import type {EngineInterface} from 'claude-code'
import type {Engine} from 'claude-code/testing'
declare const $:Engine
declare const plugin:EngineInterface
async function output(){const r=await $.tool.call({tool:'FixtureRead',file_path:'/owned/file'});if(r.deny===undefined&&r.isError!==true){const wrong:number=r.result.text;void wrong}}
async function mcp(){const r=await $.tool.call({tool:'mcp__owned__read',file_path:'/owned/file'});if(r.deny===undefined&&r.isError!==true){const text:string=r.result.text;void text}}
$.prompt.edit({origin:{kind:'composer'},text:'',cursor:0,start:0,end:0,inputText:'x'})
plugin.prompt.edit({origin:{kind:'composer'},text:'',cursor:0,start:0,end:0,inputText:'x'})`)
 expect(output.map(({file,line,code})=>({file,line,code}))).toEqual([{file:'author.ts',line:5,code:2322},{file:'author.ts',line:6,code:18046},{file:'author.ts',line:7,code:2339},{file:'author.ts',line:8,code:2339}])
})

test('testing helpers preserve the complete pinned 292 testing module without an auxiliary module',async()=>{
 const files=generateModDeclarationFiles('2.1.289',schemaTools())
 const main=files.find(file=>file.path==='claude-code/index.d.ts')!
 const official=await readFile(new URL('../../../assets/mods-2.1.292.d.ts.txt',import.meta.url),'utf8')
 const start=official.indexOf("declare module 'claude-code/testing' {")
 expect(start).toBeGreaterThanOrEqual(0)
 expect(main.text).toContain(official.slice(start))
 expect(files.some(file=>file.path==='claude-code/results.d.ts')).toBe(false)
 expect(main.text).toContain('export type EngineCall<E extends EventName>')
})


test('real source author engine forwards whole inputs and returns exact raw receipts for the typed events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'testing-event-runtime-'))
 try{
  await mkdir(join(root,'.claude-plugin'));await mkdir(join(root,'hooks'))
  await writeFile(join(root,'.claude-plugin/plugin.json'),JSON.stringify({name:'testing-event-types',version:'1.0.0'}))
  await writeFile(join(root,'hooks/hooks.json'),JSON.stringify({modules:['../register.ts']}))
  await writeFile(join(root,'register.ts'),'export function register(on) {}')
  const file=join(root,'raw.test.ts')
  await writeFile(file,`import {test,expect} from 'claude-code/testing';
    test('whole inputs and raw results',async($,on)=>{
      const seen=[];
      on('prompt.submit',(_$,e)=>{seen.push({event:'prompt.submit',input:e});return {text:e.text+':processed',context:['owned-context'],origin:e.origin}});
      on('tool.check',(_$,e)=>{seen.push({event:'tool.check',input:e});return {decision:'allow',reason:'owned-check'}});
      on('tool.call',(_$,e)=>{seen.push({event:'tool.call',input:e});return {result:{kind:'text',text:e.file_path,lines:[1]},ref:9,text:'owned-tool'}});
      const submit={text:'owned',wait:true,origin:{kind:'composer'}};
      const check={tool:'FixtureRead',input:{file_path:'/owned/file'},tool_use_id:'owned-check'};
      const call={tool:'FixtureRead',file_path:'/owned/file',tool_use_id:'owned-call'};
      expect(await $.prompt.submit(submit)).toEqual({text:'owned:processed',context:['owned-context'],origin:{kind:'composer'}});
      expect(await $.tool.check(check)).toEqual({decision:'allow',reason:'owned-check'});
      expect(await $.tool.call(call)).toEqual({result:{kind:'text',text:'/owned/file',lines:[1]},ref:9,text:'owned-tool'});
      expect(seen).toEqual([{event:'prompt.submit',input:submit},{event:'tool.check',input:check},{event:'tool.call',input:call}]);
    });`)
  const result=await runPluginTestFile(root,file)
  expect(result.loadFailure).toBeUndefined()
  expect(result.tests).toHaveLength(1)
  expect(result.tests[0]!.failure).toBeUndefined()
  console.log('testing-event-source-runtime-result',JSON.stringify(result))
 }finally{await rm(root,{recursive:true,force:true})}
})
