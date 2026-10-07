import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { ensureModDeclarations } from './declarations.js'

test('ui.fault uses closed phases, pinned input and an observe-only result in strict author declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-author-fault-'))
  try {
    const generated = await ensureModDeclarations(root, '2.1.292', [])
    await mkdir(join(root, 'tests'))
    await writeFile(
      join(root, 'tests/fault.ts'),
      `
      import type {Register,UiFaultInput,UiFaultPhase,UiFaultResult} from 'claude-code'
      const phase:UiFaultPhase='render'
      // @ts-expect-error the phase set is closed.
      const invalidPhase:UiFaultPhase='update'
      const register:Register=on=>{
        on('ui.fault',async($,e,next)=>{
          const input:Readonly<UiFaultInput>=e
          const phase:UiFaultPhase=e.phase
          const reason:string=e.reason
          const result:UiFaultResult=await next(e)
          // @ts-expect-error the result cannot carry deny.
          const invalid:UiFaultResult={deny:'no'}
          // @ts-expect-error the engine input is readonly.
          e.element='another'
          // @ts-expect-error fault observation is not a public capability.
          $.ui.fault(e)
          void [input,phase,reason,invalid];return result
        })
        // @ts-expect-error observe-only return cannot replace props.
        on('ui.fault',()=>({props:{}}))
      }
      void [phase,invalidPhase,register]
    `,
    )
    const configPath = join(generated.root, 'tsconfig.json'),
      config = ts.readConfigFile(configPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      generated.root,
      { skipLibCheck: false },
      configPath,
    )
    const diagnostics = [
      ...parsed.errors,
      ...ts.getPreEmitDiagnostics(
        ts.createProgram(parsed.fileNames, parsed.options),
      ),
    ]
      .map((x) => ts.flattenDiagnosticMessageText(x.messageText, '\n'))
      .join('\n')
    expect(diagnostics).toBe('')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
