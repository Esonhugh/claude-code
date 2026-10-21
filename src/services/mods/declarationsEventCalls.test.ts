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

// Kept inline so these author inputs remain unchanged when the test moves repositories.
const fixtures: Record<string,string> = {
 "scoped-calls-positive.ts": `import type {Engine} from 'claude-code/testing'
import type {PromptComposeInput,PromptComposeResult,AgentSpawnInput,AgentSpawnResult,ConfigSetResult,UiScrollResult,UiFocusResult,PromptSuggestResult} from 'claude-code'
declare const $: Engine
declare const compose: PromptComposeInput
declare const spawn: AgentSpawnInput
const p1: Promise<PromptComposeResult> = $.prompt.compose(compose)
const p2: Promise<AgentSpawnResult> = $.agent.spawn(spawn)
const p3: Promise<{isFilled:boolean}> = $.prompt.fill({text:'owned',mode:'replace',origin:{kind:'plugin',name:'owned'}})
const p4: Promise<PromptSuggestResult> = $.prompt.suggest({text:'owned',origin:{kind:'suggestion'}})
const p5: Promise<ConfigSetResult> = $.config.set({key:'owned',value:true,previous:false,provider:{plugin:'engine',tier:'core'},origin:{kind:'composer'}})
const p6: Promise<UiScrollResult> = $.ui.scroll({component:'Pane',requestId:'owned',offset:1,by:1,bodyRows:20,contentRows:40,origin:{kind:'person'}})
const p7: Promise<UiFocusResult> = $.ui.focus({component:'Pane',requestId:'owned',element:'button',origin:{kind:'person'}})
async function command() {
  const r = await $.command.run({command:'owned',args:'',origin:{kind:'composer'},presentation:{isFullscreen:true,columns:120}})
  const context: readonly string[] | undefined = r.context
  const ref: number | undefined = r.ref
}
async function complete() {
  const r = await $.turn.complete({turnId:'owned',answer:'done',durationMs:1,isAborted:false,reason:'answer'})
  const usage: {input_tokens:number;output_tokens:number;cache_read_input_tokens:number;cache_creation_input_tokens:number;model:string} | undefined = r.usage
}
const start: Promise<{turnId:string}> = $.turn.start({turnId:'owned',text:'owned'})
`,
 "scoped-calls-negative.ts": `import type {Engine} from 'claude-code/testing'
import type {PromptComposeInput,AgentSpawnInput} from 'claude-code'
declare const $: Engine
declare const compose: PromptComposeInput
declare const spawn: AgentSpawnInput
$.prompt.compose({...compose,model:4}) // NEGATIVE: model type
$.agent.spawn({...spawn,tool_use_id:4}) // NEGATIVE: engine tool id type
$.prompt.fill({text:4,mode:'replace',origin:{kind:'plugin',name:'owned'}}) // NEGATIVE: text
$.prompt.suggest({text:4,origin:{kind:'suggestion'}}) // NEGATIVE: text
$.config.set({key:'owned',value:{object:true},previous:false,provider:{plugin:'engine',tier:'core'},origin:{kind:'composer'}}) // NEGATIVE: value union
$.ui.scroll({component:'Pane',requestId:'owned',offset:'one',by:1,bodyRows:20,contentRows:40,origin:{kind:'person'}}) // NEGATIVE: offset
$.ui.focus({component:'Pane',requestId:'owned',element:4,origin:{kind:'person'}}) // NEGATIVE: element
$.prompt.compose({}) // NEGATIVE: complete engine input, not production partial Args
$.agent.spawn({prompt:'owned'}) // NEGATIVE: missing stamped engine input
$.prompt.fill({text:'owned'}) // NEGATIVE: mode/origin required for engine call
$.prompt.suggest({text:'owned'}) // NEGATIVE: origin required for engine call
$.config.set({key:'owned',value:true}) // NEGATIVE: previous/provider/origin required
$.ui.scroll({to:'end'}) // NEGATIVE: production sugar is not whole engine scroll input
$.ui.focus({requestId:'owned',key:'button'}) // NEGATIVE: production sugar is not whole engine focus input
$.command.run({command:'owned',args:'',origin:{kind:4}}) // NEGATIVE: origin
$.command.run({command:'owned',args:''}) // NEGATIVE: whole engine requires origin/presentation
$.turn.start({turnId:4,text:'owned'}) // NEGATIVE: turnId
$.turn.start({}) // NEGATIVE: whole input
$.turn.complete({turnId:'owned',answer:4,durationMs:1,isAborted:false,reason:'answer'}) // NEGATIVE: answer
$.turn.complete({turnId:'owned',answer:'done',durationMs:1,isAborted:false,reason:'refusal'}) // NEGATIVE: refusal branch requires refusal
`,
 "hook-input-result-positive.ts": `import type {On,ConfigValue,ConfigSetResult} from 'claude-code'
declare const on: On
on('prompt.fill',async ($,e,next)=>{
  const text: string = e.text
  const mode: 'replace'|'append'|'insert' = e.mode
  const result: {isFilled:boolean} = await next(e)
  return result
})
on('config.set',async ($,e,next)=>{
  const previous: ConfigValue = e.previous
  const event: 'config.set' = next.event
  const result: ConfigSetResult = await next(e)
  return result
})
on('ui.scroll',async ($,e,next)=>{
  const offset: number = e.offset
  const bodyRows: number = e.bodyRows
  const event: 'ui.scroll' = next.event
  const result: {deny?:string} = await next(e)
  return result
})
`,
 "hook-result-negative.ts": `import type {On} from 'claude-code'
declare const on: On
on('prompt.fill',()=>({isFilled:'yes'})) // NEGATIVE: boolean receipt
on('config.set',()=>({value:{object:true}})) // NEGATIVE: ConfigValue
on('ui.scroll',()=>({deny:4})) // NEGATIVE: deny string
on('command.describe',()=>({description:'owned',isHidden:4})) // NEGATIVE: hidden boolean
on('session.receive',()=>({text:4})) // NEGATIVE: ingress text
`,
 "canonical-event-alias-positive.ts": `import type {Args,EventOf,ResultOf,EventCalls} from 'claude-code'
import type {EngineCall} from 'claude-code/testing'
declare const input: Args<'prompt.compose'>
const same: EventOf['prompt.compose'] = input
declare const result: ResultOf['prompt.compose']
declare const call: EngineCall<'prompt.compose'>
const invoked: Promise<typeof result> = call(same)
declare const publicCalls: EventCalls
const publicInvoked: Promise<typeof result> = publicCalls.prompt.compose({model:'owned'})
`,
 "canonical-event-alias-negative.ts": `import type {Args,ResultOf} from 'claude-code'
import type {EngineCall} from 'claude-code/testing'
declare const input: Args<'prompt.compose'>
declare const call: EngineCall<'prompt.compose'>
call({...input,tools:[4]}) // NEGATIVE: event input exact
const output: ResultOf['prompt.compose'] = {sections:[{id:'owned',text:'owned',scope:'unknown'}]} // NEGATIVE: result scope
`,
 "raw-author.test.ts": `import {test,expect} from 'claude-code/testing';
test('tool.call whole input and raw receipt',async($,on)=>{on('tool.call',(_$,e,next)=>{expect(e).toEqual({"tool":"FixtureRead","file_path":"/owned/file","tool_use_id":"owned-tool"});expect(next.event).toBe('tool.call');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"result":{"kind":"text","text":"owned","lines":[1]},"ref":9}});expect(await $.tool.call({"tool":"FixtureRead","file_path":"/owned/file","tool_use_id":"owned-tool"})).toEqual({"result":{"kind":"text","text":"owned","lines":[1]},"ref":9});});
test('tool.check whole input and raw receipt',async($,on)=>{on('tool.check',(_$,e,next)=>{expect(e).toEqual({"tool":"FixtureRead","input":{"file_path":"/owned/file"},"tool_use_id":"owned-check"});expect(next.event).toBe('tool.check');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"decision":"allow","reason":"owned"}});expect(await $.tool.check({"tool":"FixtureRead","input":{"file_path":"/owned/file"},"tool_use_id":"owned-check"})).toEqual({"decision":"allow","reason":"owned"});});
test('tool.describe whole input and raw receipt',async($,on)=>{on('tool.describe',(_$,e,next)=>{expect(e).toEqual({"tool":"FixtureRead","description":"owned","provider":{"plugin":"engine","tier":"core"}});expect(next.event).toBe('tool.describe');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"description":"rewritten","isDeferred":false}});expect(await $.tool.describe({"tool":"FixtureRead","description":"owned","provider":{"plugin":"engine","tier":"core"}})).toEqual({"description":"rewritten","isDeferred":false});});
test('command.run whole input and raw receipt',async($,on)=>{on('command.run',(_$,e,next)=>{expect(e).toEqual({"command":"owned","args":"arg","origin":{"kind":"composer"},"presentation":{"columns":120,"isFullscreen":true}});expect(next.event).toBe('command.run');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"context":["owned"],"ref":9}});expect(await $.command.run({"command":"owned","args":"arg","origin":{"kind":"composer"},"presentation":{"columns":120,"isFullscreen":true}})).toEqual({"context":["owned"],"ref":9});});
test('command.describe whole input and raw receipt',async($,on)=>{on('command.describe',(_$,e,next)=>{expect(e).toEqual({"command":"owned","description":"owned","isHidden":false,"immediate":false,"provider":{"plugin":"engine","tier":"core"}});expect(next.event).toBe('command.describe');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"description":"rewritten","isHidden":true}});expect(await $.command.describe({"command":"owned","description":"owned","isHidden":false,"immediate":false,"provider":{"plugin":"engine","tier":"core"}})).toEqual({"description":"rewritten","isHidden":true});});
test('config.set whole input and raw receipt',async($,on)=>{on('config.set',(_$,e,next)=>{expect(e).toEqual({"key":"owned","value":true,"previous":false,"provider":{"plugin":"engine","tier":"core"},"origin":{"kind":"composer"}});expect(next.event).toBe('config.set');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"value":true}});expect(await $.config.set({"key":"owned","value":true,"previous":false,"provider":{"plugin":"engine","tier":"core"},"origin":{"kind":"composer"}})).toEqual({"value":true});});
test('config.describe whole input and raw receipt',async($,on)=>{on('config.describe',(_$,e,next)=>{expect(e).toEqual({"key":"owned","label":"owned","isHidden":false,"provider":{"plugin":"engine","tier":"core"}});expect(next.event).toBe('config.describe');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"label":"rewritten","isHidden":true}});expect(await $.config.describe({"key":"owned","label":"owned","isHidden":false,"provider":{"plugin":"engine","tier":"core"}})).toEqual({"label":"rewritten","isHidden":true});});
test('prompt.submit whole input and raw receipt',async($,on)=>{on('prompt.submit',(_$,e,next)=>{expect(e).toEqual({"text":"owned","wait":false,"origin":{"kind":"composer"}});expect(next.event).toBe('prompt.submit');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"text":"rewritten","context":["owned"],"origin":{"kind":"composer"}}});expect(await $.prompt.submit({"text":"owned","wait":false,"origin":{"kind":"composer"}})).toEqual({"text":"rewritten","context":["owned"],"origin":{"kind":"composer"}});});
test('prompt.fill whole input and raw receipt',async($,on)=>{on('prompt.fill',(_$,e,next)=>{expect(e).toEqual({"text":"owned","mode":"insert","origin":{"kind":"plugin","name":"owned"},"decorations":[{"start":0,"end":5,"bold":true,"color":"warning"}]});expect(next.event).toBe('prompt.fill');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"isFilled":false}});expect(await $.prompt.fill({"text":"owned","mode":"insert","origin":{"kind":"plugin","name":"owned"},"decorations":[{"start":0,"end":5,"bold":true,"color":"warning"}]})).toEqual({"isFilled":false});});
test('prompt.suggest whole input and raw receipt',async($,on)=>{on('prompt.suggest',(_$,e,next)=>{expect(e).toEqual({"text":"owned","origin":{"kind":"suggestion"}});expect(next.event).toBe('prompt.suggest');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"isShown":false}});expect(await $.prompt.suggest({"text":"owned","origin":{"kind":"suggestion"}})).toEqual({"isShown":false});});
test('prompt.section whole input and raw receipt',async($,on)=>{on('prompt.section',(_$,e,next)=>{expect(e).toEqual({"name":"memory","text":"owned"});expect(next.event).toBe('prompt.section');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"text":null}});expect(await $.prompt.section({"name":"memory","text":"owned"})).toEqual({"text":null});});
test('prompt.context whole input and raw receipt',async($,on)=>{on('prompt.context',(_$,e,next)=>{expect(e).toEqual({"blocks":[{"name":"date","text":"owned"}],"instructionFiles":[]});expect(next.event).toBe('prompt.context');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"blocks":[{"name":"date","text":"rewritten"}],"instructionFiles":[]}});expect(await $.prompt.context({"blocks":[{"name":"date","text":"owned"}],"instructionFiles":[]})).toEqual({"blocks":[{"name":"date","text":"rewritten"}],"instructionFiles":[]});});
test('prompt.attachment whole input and raw receipt',async($,on)=>{on('prompt.attachment',(_$,e,next)=>{expect(e).toEqual({"type":"todo_reminder","text":"owned","origin":{"kind":"engine"}});expect(next.event).toBe('prompt.attachment');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"text":null}});expect(await $.prompt.attachment({"type":"todo_reminder","text":"owned","origin":{"kind":"engine"}})).toEqual({"text":null});});
test('prompt.compose whole input and raw receipt',async($,on)=>{on('prompt.compose',(_$,e,next)=>{expect(e).toEqual({"model":"owned","promptModel":"owned","surfaces":["terminal"],"tools":["FixtureRead"],"outputStyle":null,"traits":[]});expect(next.event).toBe('prompt.compose');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"sections":[{"id":"owned","text":"owned","scope":"shared"}]}});expect(await $.prompt.compose({"model":"owned","promptModel":"owned","surfaces":["terminal"],"tools":["FixtureRead"],"outputStyle":null,"traits":[]})).toEqual({"sections":[{"id":"owned","text":"owned","scope":"shared"}]});});
test('skill.prompt whole input and raw receipt',async($,on)=>{on('skill.prompt',(_$,e,next)=>{expect(e).toEqual({"skill":"owned","text":"owned"});expect(next.event).toBe('skill.prompt');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"text":"rewritten"}});expect(await $.skill.prompt({"skill":"owned","text":"owned"})).toEqual({"text":"rewritten"});});
test('attribution.text whole input and raw receipt',async($,on)=>{on('attribution.text',(_$,e,next)=>{expect(e).toEqual({"kind":"commit","text":"owned"});expect(next.event).toBe('attribution.text');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"text":"rewritten"}});expect(await $.attribution.text({"kind":"commit","text":"owned"})).toEqual({"text":"rewritten"});});
test('agent.offer whole input and raw receipt',async($,on)=>{on('agent.offer',(_$,e,next)=>{expect(e).toEqual({"agent":"owned","description":"owned","source":"builtin","provider":{"plugin":"engine","tier":"core"}});expect(next.event).toBe('agent.offer');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"isOffered":false}});expect(await $.agent.offer({"agent":"owned","description":"owned","source":"builtin","provider":{"plugin":"engine","tier":"core"}})).toEqual({"isOffered":false});});
test('agent.spawn whole input and raw receipt',async($,on)=>{on('agent.spawn',(_$,e,next)=>{expect(e).toEqual({"tool_use_id":"owned-spawn","prompt":"owned","description":"owned","subagentType":"general-purpose","provider":{"plugin":"engine","tier":"core"},"parentModel":"owned","background":false,"fork":false});expect(next.event).toBe('agent.spawn');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"model":"owned","agentId":"owned-child"}});expect(await $.agent.spawn({"tool_use_id":"owned-spawn","prompt":"owned","description":"owned","subagentType":"general-purpose","provider":{"plugin":"engine","tier":"core"},"parentModel":"owned","background":false,"fork":false})).toEqual({"model":"owned","agentId":"owned-child"});});
test('turn.start whole input and raw receipt',async($,on)=>{on('turn.start',(_$,e,next)=>{expect(e).toEqual({"turnId":"owned-turn","text":"owned"});expect(next.event).toBe('turn.start');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"turnId":"owned-turn"}});expect(await $.turn.start({"turnId":"owned-turn","text":"owned"})).toEqual({"turnId":"owned-turn"});});
test('turn.complete whole input and raw receipt',async($,on)=>{on('turn.complete',(_$,e,next)=>{expect(e).toEqual({"turnId":"owned-turn","answer":"owned","durationMs":1,"isAborted":false,"reason":"answer"});expect(next.event).toBe('turn.complete');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"text":"rewritten","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"model":"owned"}}});expect(await $.turn.complete({"turnId":"owned-turn","answer":"owned","durationMs":1,"isAborted":false,"reason":"answer"})).toEqual({"text":"rewritten","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"model":"owned"}});});
test('ui.render whole input and raw receipt',async($,on)=>{on('ui.render',(_$,e,next)=>{expect(e).toEqual({"component":"Pane","surface":"terminal","requestId":"owned","props":{"title":"Owned","isFocused":false,"bodyColumns":80,"placement":"dock","scroll":{"offset":0,"bodyRows":24},"view":{}}});expect(next.event).toBe('ui.render');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {"type":"Text","props":{},"children":["owned"]}});expect(await $.ui.render({"component":"Pane","surface":"terminal","requestId":"owned","props":{"title":"Owned","isFocused":false,"bodyColumns":80,"placement":"dock","scroll":{"offset":0,"bodyRows":24},"view":{}}})).toEqual({"type":"Text","props":{},"children":["owned"]});});
test('ui.scroll whole input and raw receipt',async($,on)=>{on('ui.scroll',(_$,e,next)=>{expect(e).toEqual({"component":"Pane","requestId":"owned","offset":1,"by":1,"bodyRows":20,"contentRows":40,"origin":{"kind":"person"}});expect(next.event).toBe('ui.scroll');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {}});expect(await $.ui.scroll({"component":"Pane","requestId":"owned","offset":1,"by":1,"bodyRows":20,"contentRows":40,"origin":{"kind":"person"}})).toEqual({});});
test('ui.focus whole input and raw receipt',async($,on)=>{on('ui.focus',(_$,e,next)=>{expect(e).toEqual({"component":"Pane","requestId":"owned","element":"button","origin":{"kind":"person"}});expect(next.event).toBe('ui.focus');expect(next.origin).toEqual({"plugin": "engine", "tier": "core"});return {}});expect(await $.ui.focus({"component":"Pane","requestId":"owned","element":"button","origin":{"kind":"person"}})).toEqual({});});
test('turn.step typed stream',async($,on)=>{const result={turnId:'owned',index:0,answer:'owned',toolUses:[],stopReason:'end_turn',usage:null};on('turn.step',async function*(_$,e,next){expect(e).toEqual({turnId:'owned',index:0,model:'owned',messageCount:1});expect(next.event).toBe('turn.step');expect(next.origin).toEqual({plugin:'engine',tier:'core'});yield {kind:'text',index:0,text:'owned'};return {turnId:'owned',index:0,answer:'owned',toolUses:[],stopReason:'end_turn',usage:null}});const stream=$.turn.step({turnId:'owned',index:0,model:'owned',messageCount:1});expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'owned'}});expect(await stream.next()).toEqual({done:true,value:result});expect(await stream.result).toEqual(result);});
test('session.receive whole input and raw receipt',async($,on)=>{on('session.receive',(_$,e,next)=>{expect(e).toEqual({text:'owned',origin:{kind:'bridge'}});expect(next.event).toBe('session.receive');expect(next.origin).toEqual({plugin:'engine',tier:'core'});return {consumed:'owned'}});expect(await $.session.receive({text:'owned',origin:{kind:'bridge'}})).toEqual({consumed:'owned'});});
`,
 "prompt-fill-decorations-positive.ts": `import type {On,PromptDecoration,PromptFillInput,Args} from 'claude-code'
import type {Engine,EngineCall} from 'claude-code/testing'
declare const on:On
declare const $:Engine
const decoration:PromptDecoration={start:0,end:5,color:'warning',backgroundColor:'blue',dimColor:true,bold:true,italic:true,underline:true,strikethrough:true}
const input:PromptFillInput={text:'owned',mode:'insert',origin:{kind:'plugin',name:'owned'},decorations:[decoration]}
const alias:Args<'prompt.fill'>=input
const call:EngineCall<'prompt.fill'>=$.prompt.fill
const receipt:Promise<{isFilled:boolean}>=call(input)
on('prompt.fill',async(_$,e,next)=>{
 const decorations:readonly Readonly<PromptDecoration>[]|undefined=e.decorations
 const bold:boolean|undefined=e.decorations?.[0]?.bold
 // Official Frozen retains the array's declared mutability; this compile fixture is never executed.
 e.decorations?.push({start:0,end:5,bold:true})
 const event:'prompt.fill'=next.event
 return next({...e,decorations:[{start:0,end:5,bold:true}]})
})
`,
 "prompt-fill-decorations-negative.ts": `import type {On,PromptDecoration} from 'claude-code'
import type {Engine} from 'claude-code/testing'
declare const on:On
declare const $:Engine
const wrongStart:PromptDecoration={start:'0',end:1} // NEGATIVE: numeric offsets
const wrongColor:PromptDecoration={start:0,end:1,color:2} // NEGATIVE: string style
const wrongBold:PromptDecoration={start:0,end:1,bold:'true'} // NEGATIVE: boolean style
const extra:PromptDecoration={start:0,end:1,inverse:true} // NEGATIVE: only official decoration styles
$.prompt.fill({text:'owned',mode:'insert',origin:{kind:'plugin',name:'owned'},decorations:[{start:0,end:1,bold:3}]}) // NEGATIVE: exact whole input
on('prompt.fill',async(_$,e,next)=>{
 e.decorations=[] // NEGATIVE: readonly hook property
 if(e.decorations?.[0])e.decorations[0].bold=false // NEGATIVE: readonly hook props
 return next(e)
})
`
}
async function fixture(name:string){
 const source=fixtures[name]
 if(source===undefined)throw new Error(`Unknown event-call fixture: ${name}`)
 return source
}

test('explicit event calls keep whole input and raw receipts for existing consumers',async()=>{
 expect(await diagnostics(await fixture('scoped-calls-positive.ts'))).toEqual([])
})
test('explicit event calls reject bad fields, production sugar and missing engine stamps',async()=>{
 const source=await fixture('scoped-calls-negative.ts'),output=await diagnostics(source)
 const lines=source.split('\n').flatMap((text,index)=>text.includes('// NEGATIVE:')?[index+1]:[])
 expect(output.map(({file,line})=>({file,line}))).toEqual(lines.map(line=>({file:'author.ts',line})))
})
test('literal event On handlers have precise inputs, event name and original result',async()=>{
 expect(await diagnostics(await fixture('hook-input-result-positive.ts'))).toEqual([])
 const source=await fixture('hook-result-negative.ts'),output=await diagnostics(source)
 const lines=source.split('\n').flatMap((text,index)=>text.includes('// NEGATIVE:')?[index+1]:[])
 expect(output.map(({file,line})=>({file,line}))).toEqual(lines.map(line=>({file:'author.ts',line})))
})
test('canonical event aliases keep exact whole arguments and results in complete strict refs',async()=>{
 expect(await diagnostics(await fixture('canonical-event-alias-positive.ts'))).toEqual([])
 const output=await diagnostics(await fixture('canonical-event-alias-negative.ts'))
 expect(output.map(({file,line,code})=>({file,line,code}))).toEqual([{file:'author.ts',line:5,code:2322},{file:'author.ts',line:6,code:2322}])
})
test('real source runner existing event consumers receive complete data and original raw receipt',async()=>{
 expect(await diagnostics(await fixture('raw-author.test.ts'))).toEqual([])
 const root=await mkdtemp(join(tmpdir(),'event-map-source-runtime-'))
 try {
  await mkdir(join(root,'.claude-plugin'));await mkdir(join(root,'hooks'))
  await writeFile(join(root,'.claude-plugin/plugin.json'),JSON.stringify({name:'event-map-types',version:'1.0.0'}))
  await writeFile(join(root,'hooks/hooks.json'),JSON.stringify({modules:['../register.ts']}))
  await writeFile(join(root,'register.ts'),'export function register(on) {}')
  const file=join(root,'author.test.ts');await writeFile(file,await fixture('raw-author.test.ts'))
  const result=await runPluginTestFile(root,file)
  console.log('existing-event-map-source-runtime',JSON.stringify(result))
  expect(result.loadFailure).toBeUndefined();expect(result.tests).toHaveLength(25)
  expect(result.tests.map(item=>item.failure)).toEqual(Array(25).fill(undefined))
 } finally {await rm(root,{recursive:true,force:true})}
})
test('explicit event tables match the pinned 303 main declaration',async()=>{
 const files=generateModDeclarationFiles('2.1.289',schemaTools()),main=files.find(f=>f.path==='claude-code/index.d.ts')!
 const official=await readFile(new URL('../../../assets/mods-2.1.303.d.ts.txt',import.meta.url),'utf8')
 const start=official.indexOf('  export type EngineEventOf = {')
 const end='  export type EventName = keyof EventOf;'
 expect(start).toBeGreaterThanOrEqual(0)
 expect(official.indexOf(end,start)).toBeGreaterThan(start)
 // Compare the complete event/engine call section, independently of UI declarations.
 expect(main.text).toContain(official.slice(start,official.indexOf(end,start)+end.length))
 expect(files.some(file=>file.path==='claude-code/results.d.ts')).toBe(false)
 expect(main.text).toContain('EngineEventOf');expect(main.text).toContain('EngineResultOf')
})

test('prompt.fill exact decorations preserve readonly hook fields and typed event input',async()=>{
 expect(await diagnostics(await fixture('prompt-fill-decorations-positive.ts'))).toEqual([])
 const source=await fixture('prompt-fill-decorations-negative.ts'),output=await diagnostics(source)
 const lines=source.split('\n').flatMap((text,index)=>text.includes('// NEGATIVE:')?[index+1]:[])
 expect(output.map(({file,line,code})=>({file,line,code}))).toEqual(lines.map((line,index)=>({file:'author.ts',line,code:[2322,2322,2322,2353,2322,2540,2540][index]})))
})
