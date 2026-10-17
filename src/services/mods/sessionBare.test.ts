import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsSession, type ModsSession } from './session.js'
import { createModRemoteUIControl } from './remoteUiControl.js'
import type { SDKControlRequest } from '../../entrypoints/sdk/controlTypes.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import * as secureStorage from '../../utils/secureStorage/index.js'

const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']
let root: string
let saved: (string | undefined)[]
const cleanups: (() => unknown | Promise<unknown>)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-bare-session-'))
  saved = keys.map(key => process.env[key])
  for (const key of keys) process.env[key] = join(root, 'home')
  const storage = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({read:()=>undefined,get:async()=>undefined,update:()=>{throw new Error('unexpected credential write')},set:async()=>{throw new Error('unexpected credential write')},delete:async()=>{throw new Error('unexpected credential delete')}})
  cleanups.push(() => storage.mockRestore())
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, {recursive:true,force:true})
})
async function fixture(bare: boolean, overrides: {isTrusted?:boolean;getDisabledReason?:()=>string|undefined} = {}) {
  const path = join(root, 'plugin')
  await mkdir(path, {recursive:true})
  await writeFile(join(path, 'register.ts'), `export function register(on) {
    on('ui.render',{component:'ToolUse',surface:'desktop'},($,e)=>$.ui.resolve(e).Text({children:'PLUGIN_EXECUTED'}));
  }`)
  const plugin: LoadedPlugin = {name:'bare-probe',manifest:{name:'bare-probe'},path,source:'bare-probe@inline',repository:'bare-probe@inline',enabled:true,
    hookModules:[{configPath:join(path,'hooks.json'),paths:['./register.ts']}]}
  let loads = 0
  const session = createModsSession({bare,isTrusted:true,
    getSettings:()=>({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),
    loadPlugins:async()=>{loads++;return [plugin]},...overrides,
  })
  cleanups.push(() => session.dispose())
  await session.bind({cwd:root,surface:null,isInteractive:false,sessionId:'bare-session'})
  return {session,plugin,loads:()=>loads}
}
async function render(session: ModsSession) {
  const replies: Record<string, unknown>[] = []
  const control = createModRemoteUIControl({runtime:()=>session.runtime,
    success:(_m,response)=>replies.push(response),error:(_m,error)=>{throw new Error(error)},
  })
  cleanups.push(() => control.dispose())
  const send = async (request: SDKControlRequest['request']) => {
    control.handleRequest({type:'control_request',request_id:String(replies.length),request})
    await control.settle()
    return replies.at(-1)
  }
  const capabilities = await control.capabilities()
  const attached = await send({subtype:'ui_attach',surface:'desktop',client_id:'bare'})
  const drawing = await send({subtype:'ui_render',surface:'desktop',component:'ToolUse',instance_id:'bare',client_id:'bare',props:{}})
  const detached = await send({subtype:'ui_detach',client_id:'bare'})
  return {capabilities,attached,drawing,detached}
}

test('bare session exposes an empty UI engine without discovering or running explicit plugins', async () => {
  const {session,loads} = await fixture(true)
  expect(loads()).toBe(0)
  expect(session.runtime).toBeDefined()
  // Official 2.1.292 --bare: capability/roster remain usable; plugin drawing is not hooked.
  expect(await render(session)).toEqual({capabilities:['ui_surface_v1'],attached:{surfaces:['desktop']},
    drawing:{tree:{type:'engine',ref:0},props:{tool_use_id:'bare'},rewritten:false,hooked:false},
    detached:{detached:true,surfaces:[]}})
})
test('bare refresh ignores supplied plugin modules and keeps the same empty UI runtime', async () => {
  const {session,plugin,loads} = await fixture(true)
  const runtime = session.runtime
  await session.refresh([plugin])
  expect(session.runtime).toBe(runtime)
  expect(loads()).toBe(0)
  expect((await render(session)).drawing).toEqual({tree:{type:'engine',ref:0},props:{tool_use_id:'bare'},rewritten:false,hooked:false})
})
test('bare never requests hot reload authoring consent', async () => {
  const {session} = await fixture(true)
  await session.bind({cwd:root,surface:null,isInteractive:true,sessionId:'bare-session'})
  let prompted = false
  expect(await session.requestAuthoringConsent(async()=>{prompted=true;return {prompt_response:'bare-consent',selected:'decline'}},new AbortController().signal)).toEqual({enabled:false})
  expect(prompted).toBe(false)
})
test('ordinary sessions still load and execute their plugin drawing', async () => {
  const {session,loads} = await fixture(false)
  expect(loads()).toBe(1)
  expect((await render(session)).drawing).toEqual({tree:{type:'Text',children:['PLUGIN_EXECUTED']},props:{tool_use_id:'bare'},rewritten:false,hooked:true})
})
test.each(['untrusted','remote','node'] as const)('bare does not bypass existing %s runtime admission', async mode => {
  const {session,loads} = await fixture(true,{isTrusted:mode!=='untrusted',
    getDisabledReason:()=>mode==='remote'?'Mods are unsupported in remote/SSH sessions':mode==='node'?'Mods require the Bun CLI runtime; Node execution is unsupported':undefined})
  expect(session.runtime).toBeUndefined()
  expect(loads()).toBe(0)
})
