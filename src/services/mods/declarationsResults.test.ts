import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod/v4'
import { buildTool, type Tool } from '../../Tool.js'
import { ensureModDeclarations, generateModDeclarationFiles } from './declarations.js'
import baselineOwned from './fixtures/result-types-baseline-owned.json'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function schemaTools() {
  const tool = buildTool({
    name: 'FixtureRead',
    inputSchema: z.object({ file_path: z.string() }),
    outputSchema: z.object({ kind: z.literal('text'), text: z.string(), lines: z.array(z.number()), truncated: z.boolean().optional() }),
    maxResultSizeChars: 10000,
    description: async () => 'Read fixture', prompt: async () => 'Read fixture', renderToolUseMessage: () => null,
    call: async input => ({ data: { kind: 'text' as const, text: input.file_path, lines: [1] } }),
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data.text }),
  })
  return [tool, { ...tool, name: 'mcp__fixture__read', isMcp: true }]
}

async function authorDiagnostics(source: string, tools: readonly Tool[] = schemaTools()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-result-author-')))
  roots.push(root)
  const generated = await ensureModDeclarations(root, '2.1.289', tools)
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests/results.ts'), source)
  const configPath = join(generated.root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, generated.root, { skipLibCheck: false }, configPath)
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))]
    .map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n')
}

const returns = [
  ['agent.spawn', "Promise<{model:string;agentId?:string;teammateId?:string;deny?:undefined}|{deny:string;model?:undefined;agentId?:undefined;teammateId?:undefined}>", "$.agent.spawn({prompt:'Read fixture'})"],
  ['agent.register', 'Promise<{agent:string}>', "$.agent.register({name:'reader',description:'Reads fixtures',prompt:'Read the fixture'})"],
  ['command.list', "Promise<readonly {name:string;description:string;source:'builtin'|'plugin'|'user'|'mcp';plugin?:string}[]>", '$.command.list()'],
  ['command.register', 'Promise<{command:string}>', "$.command.register({name:'read',description:'Read fixture',immediate:true})"],
  ['config.list', "Promise<readonly {key:string;label:string;kind:'boolean'|'choice'|'text'|'number';value:boolean|string|number|readonly string[];provider:{plugin:string;tier:import('claude-code').Tier};isLocked:boolean}[]>", '$.config.list()'],
  ['config.set', 'Promise<{value:boolean|string|number|readonly string[];deny?:undefined}|{deny:string;value?:undefined}>', "$.config.set({key:'theme',value:'dark'})"],
  ['mcp.call', 'Promise<{content:{type:string;text?:string;uri?:string;mimeType?:string;[field:string]:unknown}[];isError:boolean;structuredContent?:unknown}>', "$.mcp.call('fixture','read',{file_path:'a'})"],
  ['tool.list', 'Promise<readonly {name:string;description:string;mcp:boolean}[]>', '$.tool.list()'],
  ['tool.check', "Promise<{decision:'allow'|'ask'|'deny';reason?:string;rule?:string;hook?:string}>", "$.tool.check({tool:'FixtureRead',input:{file_path:'a'}})"],
  ['tool.call', "Promise<{result:{kind:'text';text:string;lines:number[];truncated?:boolean};deny?:undefined;isError?:undefined}|{deny:string;result?:undefined;isError?:undefined}|{isError:true;result:unknown;deny?:undefined}>", "$.tool.call({tool:'FixtureRead',file_path:'a'})"],
  ['tool.register', 'Promise<{tool:string}>', "$.tool.register({name:'read',description:'Read fixture',inputSchema:{type:'object'}})"],
  ['ui.close', 'Promise<void>', "$.ui.close({id:'panel'})"],
  ['ui.blit', 'Promise<{deny?:string}>', "$.ui.blit({requestId:'panel',key:'raster',cells:'[]'})"],
  ['ui.scroll', 'Promise<{deny?:string}>', "$.ui.scroll({to:'start'})"],
  ['ui.focus', 'Promise<{deny?:string}>', "$.ui.focus({requestId:'panel',key:'button'})"],
] as const

describe('author result declarations', () => {
  test.each(returns)('checks the real generated project for %s', async (_name, expected, call) => {
    expect(await authorDiagnostics(`import type { EngineInterface } from 'claude-code'; declare const $:EngineInterface; const result:${expected}=${call}; void result`)).toBe('')
  })

  test('loads complete auxiliary results and checks literal inference and closed branches', async () => {
    expect(await authorDiagnostics(`
      import type { EngineInterface, BuiltinToolResults, ToolResultOf, ToolCallResult, AgentSpawnResult, ConfigSetResult, UiBlitArgs } from 'claude-code'
      declare const $:EngineInterface
      const declared: BuiltinToolResults['FixtureRead']={kind:'text',text:'a',lines:[1]}
      const typed: ToolResultOf<'FixtureRead'>=declared
      const call: Promise<ToolCallResult<'FixtureRead'>>=$.tool.call({tool:'FixtureRead',file_path:'a',consent:'Read it',tool_use_id:'original'})
      async function check() {
        const result=await call
        if(result.deny===undefined && result.isError!==true) {
          const text:string=result.result.text
          // @ts-expect-error Successful output is generated from outputSchema.
          const wrong:number=result.result.text
          void [text,wrong]
        }
        const mcp=await $.tool.call({tool:'mcp__fixture__read',file_path:'a'})
        if(mcp.deny===undefined && mcp.isError!==true) {
          // @ts-expect-error Official ToolResultOf leaves MCP unknown.
          const text:string=mcp.result.text
          void text
        }
      }
      // @ts-expect-error A built-in output cannot violate outputSchema.
      const invalid:ToolResultOf<'FixtureRead'>={kind:'image',text:'a',lines:[1]}
      // @ts-expect-error A denial cannot also carry a successful result.
      const mixed:ToolCallResult<'FixtureRead'>={deny:'No',result:declared}
      // @ts-expect-error Only true marks a tool error.
      const badError:ToolCallResult<'FixtureRead'>={result:declared,isError:false}
      const error:ToolCallResult<'FixtureRead'>={isError:true,result:{arbitrary:'error'},text:'Failed'}
      // @ts-expect-error Spawn branches are closed.
      const mixedSpawn:AgentSpawnResult={deny:'No',model:'haiku'}
      // @ts-expect-error Config branches are closed.
      const mixedConfig:ConfigSetResult={deny:'No',value:true}
      // @ts-expect-error A raster blit requires cells or an image source.
      const missing:UiBlitArgs={requestId:'panel',key:'raster'}
      // @ts-expect-error Literal input parameters are generated from inputSchema.
      $.tool.call({tool:'FixtureRead',file_path:7})
      void [typed,call,check,invalid,mixed,badError,error,mixedSpawn,mixedConfig,missing]
    `)).toBe('')
  })

  test('owns the complete official main declaration and schema roots without a legacy auxiliary module', async () => {
    const files = generateModDeclarationFiles('2.1.289', schemaTools())
    const main = files.find(file => file.path === 'claude-code/index.d.ts')!
    const official = await readFile(new URL('../../../assets/mods-2.1.292.d.ts.txt', import.meta.url), 'utf8')
    expect(main.text.slice('// Written by Claude Code 2.1.289.\n'.length, main.text.lastIndexOf('\n// Claude Code owned declaration sha256='))).toBe(official)
    expect(files.some(file => file.path === 'claude-code/results.d.ts')).toBe(false)
    expect(main.text).not.toContain('/// <reference path="./results.d.ts" />')
    expect(main.text).toContain('export type ToolCallResult')
    expect(files.find(file => file.path === 'claude-code-tools/index.d.ts')!.text).toContain('interface BuiltinToolResults')
    expect(files.find(file => file.path === 'claude-code-mcp/index.d.ts')!.text).not.toContain('McpToolResults')
  })

  test('narrows real tool middleware next and next.to results and closes handler returns', async () => {
    expect(await authorDiagnostics(`
      import type { Register, ToolCallResult } from 'claude-code'
      const register:Register=on => {
        on('tool.call',async ($,e,next) => {
          if(e.tool==='FixtureRead') {
            const direct:ToolCallResult<'FixtureRead'>=await next(e)
            const core:ToolCallResult<'FixtureRead'>=await next.to(e,'core')
            if(direct.deny===undefined && direct.isError!==true) {
              const text:string=direct.result.text
              // @ts-expect-error next preserves the tool's output schema.
              const wrong:number=direct.result.text
              void [text,wrong]
            }
            void core
          }
          return next(e)
        })
        // @ts-expect-error Middleware cannot return a denial beside a successful result.
        on('tool.call',() => ({deny:'No',result:{kind:'text',text:'a',lines:[1]}}))
      }
      void register
    `)).toBe('')
  })

  test('infers real Bash and Read output schemas with the complete strict project', async () => {
    const { BashTool } = await import('../../tools/BashTool/BashTool.js')
    const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
    expect(await authorDiagnostics(`
      import type { EngineInterface, BuiltinToolResults, ToolCallResult } from 'claude-code'
      declare const $:EngineInterface
      const bash:Promise<ToolCallResult<'Bash'>>=$.tool.call({tool:'Bash',command:'pwd'})
      const read:Promise<ToolCallResult<'Read'>>=$.tool.call({tool:'Read',file_path:'/fixture/a'})
      async function check() {
        const b=await bash
        if(b.deny===undefined && b.isError!==true) {
          const stdout:string=b.result.stdout
          const stderr:string=b.result.stderr
          // @ts-expect-error The real Bash schema has string stdout.
          const wrong:number=b.result.stdout
          void [stdout,stderr,wrong]
        }
        const r=await read
        if(r.deny===undefined && r.isError!==true && r.result.type==='text') {
          const content:string=r.result.file.content
          const lines:number=r.result.file.totalLines
          // @ts-expect-error The real Read text schema has string content.
          const wrong:number=r.result.file.content
          void [content,lines,wrong]
        }
      }
      declare const output:BuiltinToolResults['Bash']
      const stdout:string=output.stdout
      void [check,stdout]
    `, [BashTool, FileReadTool])).toBe('')
  })

  test('migrates the captured owned generation as a complete referenced set and is idempotent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-result-owned-')))
    roots.push(root)
    for (const [path, text] of Object.entries(baselineOwned.files)) {
      const target = join(root, '.claude-plugin/types', path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text)
    }
    const first = await ensureModDeclarations(root, '2.1.289', schemaTools())
    expect(first.written).toContain('claude-code/index.d.ts')
    expect(first.written).toContain('claude-code-tools/index.d.ts')
    for (const file of generateModDeclarationFiles('2.1.289', schemaTools()))
      expect(await readFile(join(first.root, file.path), 'utf8')).toBe(file.text)
    expect((await ensureModDeclarations(root, '2.1.289', schemaTools())).written).toEqual([])
    expect(await readFile(join(first.root, 'claude-code-mcp/index.d.ts'), 'utf8')).not.toContain('McpToolResults')
  })

  test.each(['unowned', 'modified-owned'])('preserves %s auxiliary author changes', async kind => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-result-user-')))
    roots.push(root)
    const target = join(root, '.claude-plugin/types/claude-code/results.d.ts')
    await mkdir(dirname(target), { recursive: true })
    const legacy = await import('./fixtures/legacy289-generated-owned.json')
    const original = kind === 'modified-owned' ? legacy.default['claude-code/results.d.ts'] : '// Author result contracts\n'
    const edited = original + '// User customization\n'
    await writeFile(target, edited)
    const installed = await ensureModDeclarations(root, '2.1.290', schemaTools())
    expect(installed.written).not.toContain('claude-code/results.d.ts')
    expect(await readFile(target, 'utf8')).toBe(edited)
  })
})
