import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { ensureModDeclarations } from './declarations.js'

test('ui.selection author API and hooks use the exact wrapped and unwrapped result types with strict auxiliary declarations', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-author-selection-'))
  try {
    const generated=await ensureModDeclarations(root,'2.1.289',[])
    await mkdir(join(root,'tests'))
    await writeFile(join(root,'tests/selection.ts'), `
      import type {EngineInterface,UiSelection,Register} from 'claude-code'
      import type {Engine,EngineCall} from 'claude-code/testing'
      declare const $:EngineInterface
      declare const engine:Engine
      declare const selection:EngineCall<'ui.selection'>
      const current:Promise<UiSelection|undefined>=$.ui.selection()
      const driven:Promise<{value:UiSelection|undefined;deny?:undefined}|{deny:string;value?:undefined}>=selection({})
      // @ts-expect-error Official testing Engine has no selection convenience.
      engine.ui.selection()
      // @ts-expect-error selection takes no public arguments.
      $.ui.selection({requestId:'forged'})
      // @ts-expect-error text is required and requestId is optional string.
      const bad:UiSelection={requestId:10}
      const register:Register=on=>{
        on('ui.selection',async($,e,next)=>{
          const result:{value:UiSelection|undefined;deny?:undefined}|{deny:string;value?:undefined}=await next(e)
          const targeted:typeof result=await next.to(e,'core')
          // @ts-expect-error input carries no requestId.
          const request:string=e.requestId
          void [targeted,request];return result
        })
        // @ts-expect-error selection wrappers are closed; text is mandatory.
        on('ui.selection',()=>({value:{requestId:'id'}}))
        // @ts-expect-error a denial cannot also carry selection.
        on('ui.selection',()=>({value:{text:'x'},deny:'no'}))
      }
      void [current,driven,bad,register]
    `)
    const configPath=join(generated.root,'tsconfig.json'),config=ts.readConfigFile(configPath,ts.sys.readFile)
    const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,generated.root,{skipLibCheck:false},configPath)
    const diagnostics=[...parsed.errors,...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options))].map(x=>ts.flattenDiagnosticMessageText(x.messageText,'\n')).join('\n')
    expect(diagnostics).toBe('')
  } finally { await rm(root,{recursive:true,force:true}) }
})
