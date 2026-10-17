import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { ensureModDeclarations } from './declarations.js'

test('strict complete author declarations separate ordinary next from caught next and retain exact result inference', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-author-caught-')))
  try {
    const tool = buildTool({
      name: 'FixtureRead', inputSchema: z.object({ file_path: z.string() }), outputSchema: z.object({ kind: z.literal('text'), text: z.string(), lines: z.array(z.number()) }),
      maxResultSizeChars: 1000, description: async () => 'Read', prompt: async () => 'Read', renderToolUseMessage: () => null,
      call: async input => ({ data: { kind: 'text' as const, text: input.file_path, lines: [1] } }),
      mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data.text }),
    })
    const generated = await ensureModDeclarations(root, '2.1.289', [tool, { ...tool, name: 'mcp__fixture__read', isMcp: true }])
    await mkdir(join(root, 'tests'))
    await writeFile(join(root, 'tests/caught.ts'), `
      import type { CatchHandler, Caught, HookFailure, On, Register, BuiltinToolResults, ToolResultOf } from 'claude-code'
      import { test } from 'claude-code/testing'
      // @ts-expect-error The kit imports main On privately instead of declaring a separate exported registrar.
      import type { On as TestingOn } from 'claude-code/testing'
      const output:BuiltinToolResults['FixtureRead']={kind:'text',text:'source',lines:[1]}
      const typed:ToolResultOf<'FixtureRead'>=output
      // @ts-expect-error Real outputSchema makes text a string.
      const invalid:BuiltinToolResults['FixtureRead']={kind:'text',text:1,lines:[1]}
      const register:Register=on=>{
        on('model.complete',(_$,e,next)=>{
          // @ts-expect-error Ordinary next does not carry caught fields.
          next.error
          // @ts-expect-error Ordinary next does not carry caught fields.
          next.called
          return next(e)
        }).catch((_$,e,next)=>{
          const caught:Caught=next, failure:HookFailure=next.error, called:boolean=next.called
          // Official 2.1.292 adds re-entry and the optional lent cause.
          const kind:'throw'|'timeout'|'re-entry'=failure.kind, message:string|undefined=failure.message, budget:number=failure.budget
          const cause:'lent'|undefined=failure.cause
          const reEntry:HookFailure={kind:'re-entry',cause:'lent',budget:25}
          // @ts-expect-error Failure cause is read only too.
          failure.cause='lent'
          // @ts-expect-error Caught metadata is read only.
          next.called=false
          // @ts-expect-error Failure metadata is read only.
          failure.kind='throw'
          void [caught,called,kind,message,budget,cause,reEntry];return undefined
        })
        // @ts-expect-error A closed model result cannot have numeric value.
        on('model.complete',()=>({deny:'none'})).catch(()=>({value:1}))
        on('turn.step',async function*(_$,e,next){
          // @ts-expect-error An ordinary stream next does not carry catch error.
          next.error
          return yield* next(e)
        }).catch(async function*(_$,e,next){
          const caught:Caught=next;const called:boolean=next.called;void [caught,called];return yield* next(e)
        })
        // @ts-expect-error A streaming catch must be a generator.
        on('turn.step',async function*(_$,e,next){return yield* next(e)}).catch(async()=>undefined)
      }
      test('typed registrar',($,on)=>{
        const same:On=on
        const result:void=on('model.complete',()=>({deny:'none'})).catch((_$,e,next)=>{const caught:Caught=next;void caught;return {deny:'caught'}})
        // @ts-expect-error Catch attachment returns void, not the registration.
        const wrong:{catch:Function}=on('model.complete',()=>({deny:'none'})).catch(()=>undefined)
        // @ts-expect-error Plain catches cannot have an async generator answer.
        on('model.complete',()=>({deny:'none'})).catch(async function*(){return {deny:'caught'}})
        void [same,result,wrong,$]
      })
      declare const handler:CatchHandler<(_:object,e:{name:string},next:()=>Promise<{value:string}>)=>Promise<{value:string}>>
      void [output,typed,invalid,register,handler]
    `)
    const path = join(generated.root, 'tsconfig.json')
    const config = ts.readConfigFile(path, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, generated.root, { skipLibCheck: false }, path)
    expect(parsed.options.strict).toBe(true)
    expect(parsed.options.skipLibCheck).toBe(false)
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))]
      .map(item => {const pos=item.file?.getLineAndCharacterOfPosition(item.start ?? 0);return `${pos ? `${pos.line+1}:${pos.character+1}: ` : ''}${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`}).join('\n')
    expect(diagnostics).toBe('')
  } finally { await rm(root, { recursive: true, force: true }) }
})
