import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { ensureModDeclarations } from './declarations.js'
const roots: string[] = []
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})))})
test('prompt.edit has exact author input result decoration and closed call contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-author-edit-')); roots.push(root)
  const generated = await ensureModDeclarations(root, '2.1.289', [])
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests/edit.ts'), `
    import type { Register, PromptEditInput, PromptEditResult, PromptEditOrigin, PromptDecoration, PromptBox, ClientKeyEvent, EngineInterface } from 'claude-code'
    declare const $: EngineInterface
    const origin: PromptEditOrigin = {kind: 'composer'}
    const input: PromptEditInput = {origin, text:'a😀b', cursor:3, start:3, end:3, inputText:'X', key:{key:'X', shift:true}}
    const box: PromptBox = {text:'a😀Xb', cursor:4}
    const result: PromptEditResult = {...box, decorations:[{start:-1, end:3, color:'warning', backgroundColor:'#fff', bold:true, italic:false, underline:true, strikethrough:true, dimColor:false}]}
    const run:Register = on => {
      on('prompt.edit', {origin:{kind:'composer'}}, async ($, e, next) => {
        const event:'prompt.edit'=next.event
        const key:ClientKeyEvent|undefined=e.key
        const answer:PromptEditResult=await next({...e, inputText:'Q'})
        // @ts-expect-error Host event input is immutable.
        e.cursor = 0
        // @ts-expect-error Composer is a closed origin.
        const bad:PromptEditOrigin={kind:'plugin'}
        // @ts-expect-error Decorations have no inverse style.
        const decor:PromptDecoration={start:0,end:1,inverse:true}
        // @ts-expect-error Held modifiers are true or absent, never false.
        const badKey:ClientKeyEvent={key:'x',ctrl:false}
        void [event,key,bad,decor,badKey];return answer
      })
      // @ts-expect-error prompt.edit answers a box, not a value envelope.
      on('prompt.edit',()=>({value:box}))
      // @ts-expect-error prompt.edit requires cursor, too.
      on('prompt.edit',()=>({text:'bad'}))
    }
    // @ts-expect-error prompt.edit is an editor event, not a plugin call.
    $.prompt.edit(input)
    void [run,result]
  `)
  const configPath = join(generated.root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, generated.root, {skipLibCheck: false}, configPath)
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))]
    .map(x => `${x.file?.fileName}:${x.start} ${ts.flattenDiagnosticMessageText(x.messageText, '\n')}`).join('\n')
  expect(diagnostics).toBe('')
})
