import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModHostServices } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-ui-notify-')))
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function run(body: string, services: ModHostServices, hooks = '', remote = false) {
  const entry = join(root, 'register.mjs')
  await writeFile(entry, `export function register(on){${hooks}
    on('tool.call',async $=>{const values=[];${body};return {result:values}});}`)
  runtime = createModsRuntime({ services })
  await runtime.bind({ cwd: root, surface: remote ? null : 'terminal', isInteractive: !remote, sessionId: 'notify' })
  if (remote) await runtime.remoteClients.attach({clientId:'app',surface:'desktop'})
  await runtime.reconcile([{ name: 'notifier', storageId: 'notifier@fixture', pluginRoot: root, entrypoints: [entry] }])
  return ((await runtime.dispatch('tool.call', {}, async () => ({ result: 'missed' }))) as { result: unknown }).result
}

test('$.ui.notify sends through the host channel, titling it with the plugin by default', async () => {
  const sent: unknown[] = []
  const channels = ['kitty', 'terminal_bell', 'disabled', 'none', 'no_method_available']
  expect(await run(`values.push(await $.ui.notify('tests passed', {title:'CI'}));
    for (let i = 0; i < 4; i++) values.push(await $.ui.notify('again'))`, {
    uiNotify: async notification => { sent.push(notification); return channels.shift()! },
  })).toEqual([
    { isSent: true, channel: 'kitty' },
    { isSent: true, channel: 'terminal_bell' },
    { isSent: false, reason: 'disabled' },
    { isSent: false, reason: 'no-channel' },
    { isSent: false, reason: 'no-channel' },
  ])
  expect(sent[0]).toEqual({ message: 'tests passed', title: 'CI', notificationType: 'plugin_notification' })
  expect(sent[1]).toEqual({ message: 'again', title: 'notifier', notificationType: 'plugin_notification' })
})

test('$.ui.notify answers no-surface without a host channel and rejects a failed write', async () => {
  expect(await run(`values.push(await $.ui.notify('hi'))`, {})).toEqual([{ isSent: false, reason: 'no-surface' }])
  await runtime?.dispose()
  runtime = undefined
  expect(await run(`try { await $.ui.notify('hi') } catch (error) { values.push(error.message) }`, {
    uiNotify: async () => 'error',
  })).toEqual(["notifier: $.ui.notify: the channel's write failed"])
})

test('terminal validates schedule options, sends now, and has no held notification to cancel', async () => {
  const sent: string[] = []
  const result = await run(`
    values.push(await $.ui.notify('ready', {key:'build',delayMs:60000,untilBack:true}));
    values.push(await $.ui.cancelNotify('build'));
    for (const options of [{at:0,delayMs:1},{delayMs:604800001},{key:'constructor'},{untilBack:'yes'}]) {
      try { await $.ui.notify('bad', options); values.push(false) } catch { values.push(true) }
    }`, {uiNotify: async n => {sent.push(n.message); return 'kitty'}},
    `on('ui.notify', {key:'build'}, ($,e,next) => next({...e,text:e.text+':'+e.delayMs}));`)
  expect(sent).toEqual(['ready:60000'])
  expect(result).toEqual([{isSent:true,channel:'kitty'},{isSent:false},true,true,true,true])
})

test('attached client gets source-scoped scheduled notification, keyed cancel and unload cleanup', async () => {
  const frames: unknown[] = []
  expect(await run(`values.push(await $.ui.notify('ready',{title:'CI',key:'nightly',delayMs:500,untilBack:true}));
    values.push(await $.ui.cancelNotify('nightly'))`, {
    uiNotify: async (_, frame) => {frames.push(frame);return 'client'},
    uiCancelNotify: frame => {frames.push(frame);return true},
  },'',true)).toEqual([{isSent:true,channel:'client'},{isSent:true}])
  await runtime!.reconcile([])
  expect(frames).toEqual([
    {type:'system',subtype:'ui_notify',source:'notifier@fixture',plugin:'notifier',text:'ready',title:'CI',key:'nightly',delay_ms:500,until_back:true,rewritten:false},
    {source:'notifier@fixture',plugin:'notifier',key:'nightly'},
    {source:'notifier@fixture',plugin:'notifier'},
  ])
})

test('$.ui.notify checks its arguments and runs ui.notify hooks that rewrite, answer or deny', async () => {
  const sent: unknown[] = []
  const hooks = `on('ui.notify', async ($, e, next) => {
      if (e.text === 'deny') return {deny:'not now'};
      if (e.text === 'answer') return {value:{isSent:false,reason:'refused'}};
      return next({...e, text:e.text + '!'});
    });`
  const result = await run(`
    for (const args of [[7], ['x', {title:3}], ['x', null]]) {
      try { await $.ui.notify(...args) } catch (error) { values.push(error.message) }
    }
    try { await $.ui.notify('deny') } catch (error) { values.push(error.message) }
    values.push(await $.ui.notify('answer'));
    values.push(await $.ui.notify('rewrite'));`, {
    uiNotify: async notification => { sent.push(notification); return 'ghostty' },
  }, hooks)
  expect(result).toEqual([
    'notifier: $.ui.notify takes a string text',
    'notifier: $.ui.notify title is a string, when given',
    'notifier: $.ui.notify title is a string, when given',
    'not now',
    { isSent: false, reason: 'refused' },
    { isSent: true, channel: 'ghostty' },
  ])
})
