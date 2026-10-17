import {expect,test} from 'bun:test'
import ts from 'typescript'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'

const fixture=`import {sanitizePromptFillInput} from './promptFillUnicode.js'
const result=sanitizePromptFillInput({text:'\\r' as const,mode:'replace' as const,origin:{kind:'plugin' as const,name:'owned' as const},extra:'kept' as const,decorations:[{start:2 as const,end:4 as const,bold:true,color:'red'}]})
`
const positive=fixture+`
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false
type Assert<T extends true>=T
type Text=Assert<Equal<typeof result.text,string>>
type Run=NonNullable<typeof result.decorations>[number]
type Start=Assert<Equal<Run['start'],number>>
type End=Assert<Equal<Run['end'],number>>
type Bold=Assert<Equal<Run['bold'],boolean|undefined>>
type Color=Assert<Equal<Run['color'],string|undefined>>
const mode:'replace'=result.mode
const origin:'owned'=result.origin.name
const extra:'kept'=result.extra
export type {Text,Start,End,Bold,Color}
export {mode,origin,extra}
`
const negative=fixture+`
const oldText:'\\r'=result.text
const oldStart:2=result.decorations![0]!.start
const oldEnd:4=result.decorations![0]!.end
const requiredBold:boolean=result.decorations![0]!.bold
const requiredColor:string=result.decorations![0]!.color
`
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
function declarations(source:string,names:string[]){
 const file=ts.createSourceFile('canonical.ts',source,ts.ScriptTarget.Latest,true)
 return names.map(name=>{const node=file.statements.find(n=>ts.isTypeAliasDeclaration(n)&&n.name.text===name);if(!node)throw Error('Missing actual canonical DTO '+name);return node.getText(file)}).join('\n')
}
test('cleaned fill output widens text and offsets while preserving mode/origin and canonical optional styles',async()=>{
 const root=await mkdtemp(join(tmpdir(),'owned-fill-types-'))
 try{
  // Type-only project uses the exact current canonical DTO declarations, avoiding unrelated implementation graph.
  // Actual production imports are separately checked by the whole source project tsc.
  const helper=await readFile(new URL('./promptFillUnicode.ts',import.meta.url),'utf8')
  const adapter=await readFile(new URL('./promptAdapter.ts',import.meta.url),'utf8')
  const edit=await readFile(new URL('./promptEdit.ts',import.meta.url),'utf8')
  const dto=declarations(adapter,['PromptFillMode','PromptFillInput'])
  const decoration=declarations(edit,['PromptDecoration'])
  await Promise.all([
   writeFile(join(root,'promptFillUnicode.ts'),helper),
   writeFile(join(root,'promptAdapter.d.ts'),`import type {PromptDecoration} from './promptEdit.js'\n${dto}\n`),
   writeFile(join(root,'promptEdit.d.ts'),decoration+'\n'),
   writeFile(join(root,'positive.ts'),positive),writeFile(join(root,'negative.ts'),negative),
  ])
  const options:ts.CompilerOptions={strict:true,skipLibCheck:false,noEmit:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[],lib:['lib.es2023.d.ts','lib.dom.d.ts']}
  const diagnostics=(name:string)=>ts.getPreEmitDiagnostics(ts.createProgram([join(root,name)],options)).map(d=>{const at=d.file?.getLineAndCharacterOfPosition(d.start??0);return{file:d.file?.fileName,line:at?at.line+1:null,column:at?at.character+1:null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}})
  const actual={source_only:true,native_started:false,strict:true,skipLibCheck:false,helper_sha256:sha(helper),canonical_input_sha256:sha(dto),canonical_decoration_sha256:sha(decoration),positive:diagnostics('positive.ts'),negative:diagnostics('negative.ts')}
  console.log(JSON.stringify(actual))
  expect(actual.positive).toEqual([])
  expect(actual.negative.map(d=>({file:d.file?.endsWith('/negative.ts'),line:d.line,code:d.code}))).toEqual([4,5,6,7,8].map(line=>({file:true,line,code:2322})))
 }finally{await rm(root,{recursive:true,force:true})}
},15000)
