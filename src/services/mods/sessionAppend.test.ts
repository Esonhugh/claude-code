import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModHostServices } from './runtime.js'
import { appendModQueueRecord, appendModToolResult, rewriteSessionAppendContent, sessionAppendEngineMessage } from './sessionAppend.js'
import { createUserMessage } from '../../utils/messages.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-append-')))
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function load(source: string, services: ModHostServices = {}) {
  const entry = join(root, 'register.mjs')
  await writeFile(entry, source)
  runtime = createModsRuntime({ services })
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'append-fixture' })
  await runtime.reconcile([{ name: 'appender', storageId: 'appender@fixture', pluginRoot: root, entrypoints: [entry] }])
  return runtime
}
async function call(body: string, services: ModHostServices = {}, hooks = '') {
  await load(`export function register(on) { ${hooks} on('tool.call', async $ => {
    try { return {result: await (async()=>{${body}})()} }
    catch (error) { return {result:{error:String(error.message),name:error.name}} }
  }) }`, services)
  const result = await runtime!.dispatch('tool.call', {}, async () => ({ result: 'missed' })) as { result: unknown }
  return result.result as any
}

test('$.session.append keeps a user-role isMeta row and a one-block notice', async () => {
  const rows: unknown[] = []
  const appendMessage: ModHostServices['appendMessage'] = row => { rows.push(row) }
  const user = await call(`return await $.session.append({message:{type:'user',content:[{type:'text',text:'note'}]}})`, { appendMessage })
  expect(user).toEqual({ message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'note' }] }, uuid: expect.any(String) })
  await runtime!.dispose()
  const notice = await call(`return await $.session.append({message:{type:'system',content:[{type:'text',text:'heads up'}]}})`, { appendMessage })
  expect(notice.message).toEqual({ type: 'system', content: [{ type: 'text', text: 'heads up' }] })
  expect(rows).toEqual([user, notice])
})

test('$.session.append refuses other blocks, multi-block notices, subagents and hosts without a conversation', async () => {
  const appendMessage = () => {}
  expect(await call(`return await $.session.append({message:{type:'user',content:[{type:'image',source:{}}]}})`, { appendMessage }))
    .toEqual({ error: 'appender: $.session.append: a image block the conversation does not take from a plugin (a row a plugin appends carries text blocks)', name: 'HooksError' })
  await runtime!.dispose()
  expect((await call(`return await $.session.append({message:{type:'system',content:[{type:'text',text:'a'},{type:'text',text:'b'}]}})`, { appendMessage })).error)
    .toBe('appender: $.session.append: a notice that is not one text block')
  await runtime!.dispose()
  expect((await call(`return await $.session.append({message:{type:'user',content:[{type:'text',text:'a'}]},agentId:'a1'})`, { appendMessage })).error)
    .toBe('appender: $.session.append: no running loop is a1')
  await runtime!.dispose()
  expect((await call(`return await $.session.append({message:{type:'user',content:[{type:'text',text:'a'}]}})`)).error)
    .toBe('appender: $.session.append: this session keeps no conversation to append to')
  await runtime!.dispose()
  expect((await call(`return await $.session.append({message:{type:'assistant',content:[]}})`, { appendMessage })).error)
    .toContain('$.session.append takes { message: { type: "user" | "system", content } }')
})

test('a session.append hook rewrites a note or refuses it with deny', async () => {
  const rows: any[] = []
  const appendMessage: ModHostServices['appendMessage'] = row => { rows.push(row) }
  const rewritten = await call(
    `return await $.session.append({message:{type:'user',content:[{type:'text',text:'secret'}]}})`,
    { appendMessage },
    `on('session.append', {door:'note'}, ($, e, next) => next({...e, message:{...e.message, content:[{type:'text',text:'[redacted]'}]}}));`,
  )
  expect(rewritten.message.content).toEqual([{ type: 'text', text: '[redacted]' }])
  expect(rows[0].message.content).toEqual([{ type: 'text', text: '[redacted]' }])
  await runtime!.dispose()
  const denied = await call(
    `return await $.session.append({message:{type:'user',content:[{type:'text',text:'x'}]}})`,
    { appendMessage },
    `on('session.append', () => ({deny:'not here'}));`,
  )
  expect(denied).toEqual({ deny: 'not here' })
  expect(rows).toHaveLength(1)
})

test('session.append rewrites a tool result before the model reads it and keeps its tool_use_id', async () => {
  await load(`export function register(on) {
    on('session.append', {door:'tool-result'}, ($, e, next) => next({...e, message:{...e.message,
      content: e.message.content.map(b => b.type === 'tool_result' ? {...b, tool_use_id:'forged', content:'scrubbed'} : b)}}))
  }`)
  const row = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'token=abc' }] })
  const snapshot = runtime!.capture({})
  try {
    const kept = await appendModToolResult(snapshot, row, [{ id: 'toolu_1', name: 'Bash' }], { abortController: new AbortController() })
    expect(kept.message.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'scrubbed' }])
    expect(kept.uuid).toBe(row.uuid)
  } finally { snapshot.release() }
})

test('session.append door queue rewrites a queue record text and keeps the door and origin pinned', async () => {
  await load(`export function register(on) {
    on('session.append', {door:'queue'}, ($, e, next) => next({...e, door:e.door, origin:e.origin,
      message:{...e.message, content:[{type:'text',text:e.origin.kind + ':' + e.message.content[0].text.toUpperCase()}]}}))
  }`)
  const snapshot = runtime!.capture({})
  try {
    expect(await appendModQueueRecord(snapshot, 'queued prompt', { kind: 'composer' })).toBe('composer:QUEUED PROMPT')
  } finally { snapshot.release() }
})

test('rewriteSessionAppendContent refuses added media and a changed tool_result count', () => {
  const original = [{ type: 'tool_result', tool_use_id: 't', content: 'a' }]
  expect(rewriteSessionAppendContent(original, [...original, { type: 'image', source: {} }])).toBeUndefined()
  expect(rewriteSessionAppendContent(original, [])).toBeUndefined()
  expect(rewriteSessionAppendContent(original, [{ type: 'text', text: 'pre' }, { type: 'tool_result', content: 'b', is_error: true }]))
    .toEqual([{ type: 'text', text: 'pre' }, { type: 'tool_result', tool_use_id: 't', content: 'b', is_error: true }])
})

test('sessionAppendEngineMessage builds the engine rows hosts keep', () => {
  const user = sessionAppendEngineMessage({ message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'n' }] }, uuid: 'u-1' })
  expect(user).toMatchObject({ type: 'user', isMeta: true, uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: 'n' }] } })
  const notice = sessionAppendEngineMessage({ message: { type: 'system', content: [{ type: 'text', text: 's' }] }, uuid: 'u-2' })
  expect(notice).toMatchObject({ type: 'system', content: 's', level: 'info', uuid: 'u-2' })
})
