import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModToolNotices } from './uiNotice.js'
import { createModsRuntime } from './runtime.js'

test('notices survive dialog mount, enforce call ownership, and clear on resolution', () => {
  const notices = createModToolNotices()
  let changes = 0
  const unsubscribe = notices.subscribe(() => changes++)
  expect(notices.set('missing','other','checked')).toBe('no call with that tool_use_id is open')
  const close = notices.open('plugin-call','owner')
  expect(notices.set('plugin-call','other','checked')).toBe("the call is another plugin's $.tool.call run")
  expect(notices.set('plugin-call','owner','checked')).toBeUndefined()
  const beforeMount = notices.read('plugin-call')
  expect(beforeMount).toEqual({plugin:'owner',text:'checked'})
  notices.set('plugin-call','owner','checked')
  expect(notices.read('plugin-call')).toBe(beforeMount)
  expect(changes).toBe(1)
  expect(notices.set('plugin-call','other',undefined)).toBe("the call is another plugin's $.tool.call run")
  notices.set('plugin-call','owner',undefined)
  expect(notices.read('plugin-call')).toBeUndefined()
  notices.set('plugin-call','owner','again')
  close()
  expect(notices.read('plugin-call')).toBeUndefined()
  expect(notices.set('plugin-call','owner','stale')).toBe('no call with that tool_use_id is open')
  const oldClose = notices.open('reused')
  const newClose = notices.open('reused')
  oldClose()
  expect(notices.set('reused','other','current')).toBeUndefined()
  notices.set('reused','any',undefined)
  expect(notices.read('reused')).toBeUndefined()
  newClose()
  unsubscribe()
})

test('Worker ui.notice returns synchronous void, supports middleware and reports closed calls', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-ui-notice-')))
  const keys = ['HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']
  const saved = keys.map(key=>process.env[key])
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root,'config')
  process.env.ANTHROPIC_API_KEY = 'sk-ui-notice-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  const diagnostic = Promise.withResolvers<string>()
  const invalidId = Promise.withResolvers<string>()
  const invalidText = Promise.withResolvers<string>()
  const runtime = createModsRuntime({onDiagnostic:entry=>{
    if(entry.message.includes('missing refused:')) diagnostic.resolve(entry.message)
    if(entry.message.includes('takes the tool_use_id')) invalidId.resolve(entry.message)
    if(entry.message.includes('takes text or undefined')) invalidText.resolve(entry.message)
  }})
  const path = join(root,'register.mjs')
  let snapshot: ReturnType<typeof runtime.capture> | undefined
  try {
    await writeFile(path, `export function register(on) {
      on('ui.notice', ($, e, next) => next(typeof e.text === 'string' ? {...e,text:'rewritten:'+e.text} : e));
      on('tool.call', $ => {
        const result=$.ui.notice('open-call','checked');
        $.ui.notice('missing','checked');
        // Official 2.1.292 passes raw values through the synchronous void wrapper.
        $.ui.notice(7,'checked');
        $.ui.notice('open-call',3);
        return {result:{isVoid:result===undefined}};
      });
    }`)
    await runtime.reconcile([{name:'notice-test',storageId:'notice-test@local',pluginRoot:root,entrypoints:[path]}])
    snapshot = runtime.capture()
    const observed = Promise.withResolvers<void>()
    const notices = snapshot.toolNotices!
    const unsubscribe = notices.subscribe(()=>observed.resolve())
    const close = notices.open('open-call')
    expect(await snapshot.dispatch('tool.call', {}, async()=>({result:'missed'}))).toEqual({result:{isVoid:true}})
    await observed.promise
    expect(notices.read('open-call')).toEqual({plugin:'notice-test',text:'rewritten:checked'})
    expect(await diagnostic.promise).toContain('$.ui.notice: missing refused: no call with that tool_use_id is open')
    expect(await invalidId.promise).toContain('takes the tool_use_id of an open call')
    expect(await invalidText.promise).toContain('takes text or undefined')
    close()
    expect(notices.read('open-call')).toBeUndefined()
    unsubscribe()
  } finally {
    snapshot?.release()
    await runtime.dispose()
    keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i]})
    await rm(root,{recursive:true,force:true})
  }
})
