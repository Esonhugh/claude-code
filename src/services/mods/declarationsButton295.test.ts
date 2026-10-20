import {expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {withButtonChildrenDeclarations,buttonChildrenDeclarationNote} from './buttonChildrenDeclarations.js'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

function diagnostics(author:string) {
  const files:Record<string,string>={'/virtual/claude-code/index.d.ts':generateModDeclarationFiles('2.1.280')[0]!.text,'/virtual/author.ts':author}
  const options:ts.CompilerOptions={strict:true,noUncheckedIndexedAccess:true,skipLibCheck:false,noEmit:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[],lib:['lib.es2023.d.ts']}
  const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host),directory=host.directoryExists?.bind(host)
  host.readFile=path=>files[path]??read(path)
  host.fileExists=path=>Object.hasOwn(files,path)||exists(path)
  host.directoryExists=path=>Object.keys(files).some(file=>file.startsWith(path+'/'))||directory?.(path)===true
  return ts.getPreEmitDiagnostics(ts.createProgram(Object.keys(files),options,host)).map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n'))
}

test('public Button render nodes carry the same held children field as official295',()=>{
  expect(diagnostics(`import type {RenderElement,RenderNode} from 'claude-code';
    const button:Extract<RenderElement,{type:'Button'}>={type:'Button',props:{key:'save',label:'accessible name'},
      children:['Save ',{type:'Text',props:{dimColor:true},children:['2m']}],press:{plugin:'fixture',handle:1}};
    const child:RenderNode|undefined=button.children?.[0];`)).toEqual([])
})

const canonical=readFileSync(new URL('../../../assets/mods-2.1.292.d.ts.txt',import.meta.url),'utf8')
const rawDelta=readFileSync(new URL('../../../assets/mods-button-2.1.295.json.txt',import.meta.url),'utf8')
const delta=JSON.parse(rawDelta) as {baselineSHA256:string;officialSHA256:string;blocks:{name:string;before:string;after:string;beforeSHA256:string;afterSHA256:string}[]}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')

test('only pinned official295 Button blocks change; all other292 declarations stay byte-identical',()=>{
  expect(sha(canonical)).toBe('ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3')
  expect(sha(rawDelta)).toBe('528493b3222e0be73a7a8bac76a5cb89c079bf118524d41863bb0e7f47d2c4b0')
  expect(delta.officialSHA256).toBe('ca0ab16c1f79f247c9de2a574bc81bf8bc7fa401e45bdfc7809337615c0ab351')
  expect(delta.blocks.map(block=>block.name)).toEqual(['ButtonProps','RenderElement.Button'])
  let expected=canonical
  for(const block of delta.blocks){
    expect(sha(block.before)).toBe(block.beforeSHA256)
    expect(sha(block.after)).toBe(block.afterSHA256)
    expect(expected.split(block.before)).toHaveLength(2)
    expected=expected.replace(block.before,block.after)
  }
  const output=generateModDeclarationFiles('2.1.280')[0]!.text
  const start=output.indexOf('// Claude Code function hooks:'),end=output.lastIndexOf('\n// Claude Code owned declaration sha256=')
  const body=output.slice(start,end)
  expect(body).toBe(expected)
  let restored=body
  for(const block of delta.blocks)restored=restored.replace(block.after,block.before)
  expect(restored).toBe(canonical)
  expect(output).toContain(buttonChildrenDeclarationNote)
  expect(body).not.toContain("'ui.notify'")
  expect(body).not.toContain('export type RegisteredToolSpec')
  expect(()=>withButtonChildrenDeclarations(canonical+'\n')).toThrow('source identity changed')
})

test('hash-pinned declaration assets keep their bytes in a CRLF checkout',()=>{
  const root=fileURLToPath(new URL('../../../',import.meta.url))
  for(const path of ['assets/mods-2.1.292.d.ts.txt','assets/mods-button-2.1.295.json.txt']){
    const stored=execFileSync('git',['cat-file','blob',`HEAD:${path}`],{cwd:root})
    const checkedOut=execFileSync('git',['-c','core.autocrlf=true','cat-file','--filters',`HEAD:${path}`],{cwd:root})
    expect(sha(checkedOut.toString('utf8'))).toBe(sha(stored.toString('utf8')))
  }
})
