import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validatePluginContents } from '../../utils/plugins/validatePlugin.js'
import captured from './fixtures/validate-notes-official292.json'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function notes(source: string, dependencies: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mod-validation-notes-'))
  roots.push(root)
  await mkdir(join(root, '.claude-plugin'))
  await mkdir(join(root, 'hooks'))
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'validation-probe' }))
  await writeFile(join(root, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.mjs'] }))
  await writeFile(join(root, 'hooks/register.mjs'), source)
  for (const [name, text] of Object.entries(dependencies)) await writeFile(join(root, 'hooks', name), text)
  const result = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')!
  expect(result.success).toBe(true)
  return result.notes!
}

test.each(captured.examples)('validate notes match captured official292 $name example registrations and helpers', async example => {
  const root = resolve(import.meta.dir, '../../../examples/mods', example.name)
  const result = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')!
  expect(result.success).toBe(true)
  for (const note of example.notes) expect(result.notes).toContain(note)
})

test('validate preserves registration order and distinct matchers for repeated events', async () => {
  expect(await notes(`export function register(on) {
    on('tool.call', {tool:'Read'}, ($,e,next) => next(e));
    on('tool.call', {tool:'Bash'}, ($,e,next) => next(e));
    on('tool.call', ($,e,next) => next(e));
  }`)).toContain('./register.mjs hooks: tool.call{tool=Read}, tool.call{tool=Bash}, tool.call')
})

test('validate formats regex, lists, nested fields and primitive constants using official AST grammar', async () => {
  expect(await notes(`const ID='review pane'; const KIND='safe';
    export function register(on) {
      on('tool.call', {tool:['Read',/File.*/i],flags:{enabled:true,count:4},input:{args:{kind:KIND}}}, ($,e,next) => next(e));
      on('ui.render', {component:'Pane',requestId:ID}, ($,e,next) => next(e));
    }`)).toContain('./register.mjs hooks: tool.call{tool=Read|/"File.*"/i, flags has {enabled=true, count=4}, input.args has {kind=safe}}, ui.render{component=Pane, requestId="review pane"}')
})

test('validate sorts distinct helper names and omits via when the same call is direct', async () => {
  const result = await notes(`const alpha = $ => $.fs.read('file');
    function zebra($) { return $.fs.read('file') }
    function inner($) { return $.fs.exists('file') }
    function outer($) { return inner($) }
    export function register(on) {
      on('session.start', async ($,e,next) => {
        await zebra($); await alpha($); await zebra($); await outer($); await $.fs.exists('file');
        return next(e);
      });
    }`)
  expect(result).toContain('./register.mjs calls: $.fs.exists, $.fs.read (via alpha, zebra)')
})

test('validate escapes and bounds diagnostic text without evaluating imported constants or module code', async () => {
  const long = 'x'.repeat(125)
  const result = await notes(`import {IMPORTED} from './constants.mjs';
    throw Error('module must not execute while validating');
    export function register(on) {
      on('tool.call', {tool:IMPORTED, input:{label:'中文  text',long:${JSON.stringify(long)},negative:-1}}, ($,e,next) => next(e));
    }`, { 'constants.mjs': `export const IMPORTED='Bash'` })
  expect(result).toContain('./register.mjs hooks: tool.call{tool=?, input has {label="\\u4e2d\\u6587 \\u0020text", long=' + JSON.stringify('x'.repeat(120)) + '[+5 chars], negative=?}}')
})
