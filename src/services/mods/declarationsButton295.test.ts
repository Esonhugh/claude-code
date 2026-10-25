import {expect,test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
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

const canonical=readFileSync(new URL('../../../assets/mods-2.1.303.d.ts.txt',import.meta.url),'utf8')
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')

test('the 303 baseline carries Button children itself, so no overlay is applied',()=>{
  const output=generateModDeclarationFiles('2.1.280')[0]!.text
  const start=output.indexOf('// Claude Code function hooks:'),end=output.lastIndexOf('\n// Claude Code owned declaration sha256=')
  expect(output.slice(start,end)).toBe(canonical)
  expect(canonical).toContain('where it holds `children`, the name')
  expect(canonical).toContain("'ui.notify'")
  expect(canonical).toContain('export type RegisteredToolSpec')
})

test('hash-pinned declaration assets keep their bytes in a CRLF checkout',()=>{
  const root=fileURLToPath(new URL('../../../',import.meta.url))
  for(const path of ['assets/mods-2.1.292.d.ts.txt','assets/mods-2.1.303.d.ts.txt']){
    const stored=execFileSync('git',['cat-file','blob',`HEAD:${path}`],{cwd:root})
    const checkedOut=execFileSync('git',['-c','core.autocrlf=true','cat-file','--filters',`HEAD:${path}`],{cwd:root})
    expect(sha(checkedOut.toString('utf8'))).toBe(sha(stored.toString('utf8')))
  }
})
