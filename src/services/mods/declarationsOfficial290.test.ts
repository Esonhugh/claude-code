import {expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

const sourceHash = '55d3a5dd98072b125135fae6fdc037f781b3ed9ad007dcd3ea4d657404d0b11f'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function project(author: string, canonical?: string) {
  const files = Object.fromEntries(generateModDeclarationFiles('2.1.280', []).filter(file => file.path.endsWith('.d.ts')).map(file => ['/virtual/' + file.path, file.text]))
  files['/virtual/author.ts'] = author
  if (canonical !== undefined) {
    delete files['/virtual/claude-code/results.d.ts']
    files['/virtual/claude-code/index.d.ts'] = canonical
  }
  const options: ts.CompilerOptions = {strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ['lib.es2023.d.ts']}
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host), directory = host.directoryExists?.bind(host)
  host.readFile = path => files[path] ?? read(path)
  host.fileExists = path => Object.hasOwn(files, path) || exists(path)
  host.directoryExists = path => Object.keys(files).some(file => file.startsWith(path + '/')) || directory?.(path) === true
  return ts.createProgram(Object.keys(files), options, host)
}

test('pinned declaration source is the verified official 290 native asset', async () => {
  const text = await readFile(new URL('../../../assets/mods-2.1.290.d.ts.txt', import.meta.url), 'utf8')
  expect(sha(text)).toBe(sourceHash)
  expect(Buffer.byteLength(text)).toBe(600277)
})

test('generated public definitions preserve the complete current official declaration body', async () => {
  const body = await readFile(new URL('../../../assets/mods-2.1.292.d.ts.txt', import.meta.url), 'utf8')
  const currentHash = 'ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3'
  const output = generateModDeclarationFiles('2.1.280', []).find(file => file.path === 'claude-code/index.d.ts')!.text
  const start = output.indexOf('// Claude Code function hooks:')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(sha(output.slice(start, start + body.length))).toBe(currentHash)
  expect(output.startsWith('// Written by Claude Code 2.1.280.\n')).toBe(true)
})

test('all official public names and operation maps are available without widening', () => {
  const program = project(''), checker = program.getTypeChecker()
  expect(ts.getPreEmitDiagnostics(program).map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([])
  const module = checker.getAmbientModules().find(symbol => symbol.name === '"claude-code"')!
  const exports = checker.getExportsOfModule(module)
  expect(exports).toHaveLength(565)
  const counts = {EventOf: 140, ResultOf: 140, OpEventOf: 61, OpValueOf: 61, EventCalls: 11}
  for (const [name, count] of Object.entries(counts)) {
    const symbol = exports.find(symbol => symbol.name === name)!
    expect(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol)), name).toHaveLength(count)
  }
})

test('strict authors can use the new color, mention, ceiling and server-tool definitions', async () => {
  const author = `import type {Register, Color, ThemeKey, TurnStepServerToolUse, OpEventOf, OpValueOf, Args, ResultOf} from 'claude-code';
    const theme:ThemeKey='diffAddedWord', color:Color='#123456';
    const server:TurnStepServerToolUse={id:'s',name:'advisor',input:{question:'x'},startedAt:1,endedAt:2};
    const copy:OpEventOf['ui.copy']={text:'x',surface:'terminal'};
    const copied:OpValueOf['ui.copy']={isCopied:false,reason:'no-clipboard'};
    const mention:Args<'prompt.mention'>={mention:'x#L1',path:'/owned/x',offset:1,limit:1,agentId:'a'};
    const refusal:ResultOf['prompt.mention']={deny:'held'};
    export const register:Register=on=>{
      on('tool.check',async($,e,next)=>{
        const agent:string|undefined=e.agentId, ceiling:'allow'|'ask'|'deny'|undefined=e.ceiling;
        const verdict=await next(e);const final:'allow'|'ask'|'deny'|undefined=verdict.ceiling;
        // @ts-expect-error Author events are deeply frozen.
        e.agentId='forged';
        // @ts-expect-error A query cannot inject the engine's loop identity.
        $.tool.check({tool:'Read',input:{},agentId:'forged'});
        void[agent,ceiling,final];return verdict;
      });
      on('turn.step',async function*($,e,next){
        const response=yield* next(e);const records:readonly TurnStepServerToolUse[]|undefined=response.serverToolUses;
        // @ts-expect-error The public turn API exposes abort alone.
        $.turn.step(e);
        void records;return response;
      });
      on('prompt.mention',async($,e,next)=>next({...e,path:'/owned/other'}));
    };
    void[theme,color,server,copy,copied,mention,refusal];`
  const canonical = await readFile(new URL('../../../assets/mods-2.1.292.d.ts.txt', import.meta.url), 'utf8')
  expect(ts.getPreEmitDiagnostics(project(author, canonical)).map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([])
  const program = project(author)
  expect(ts.getPreEmitDiagnostics(program).map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([])
})
