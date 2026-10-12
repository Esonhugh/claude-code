import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import React from 'react'
import { Text, render } from '../../ink.js'
import instances from '../../ink/instances.js'
import { startSelection, updateSelection } from '../../ink/selection.js'
import { createModsRuntime, type ModHostServices } from './runtime.js'

const roots: string[] = []
const runtimes: ReturnType<typeof createModsRuntime>[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true})))
})
async function runtimeWith(services: ModHostServices = {}, hook = '', diagnostics: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'mods-ui-selection-')); roots.push(root)
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('tool.call', async $ => ({result: await $.ui.selection({ignored:true})})); ${hook}
  }`)
  const runtime = createModsRuntime({services,onDiagnostic:row=>diagnostics.push(row.message)}); runtimes.push(runtime)
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'selection'})
  await runtime.reconcile([{name:'selection-caller',storageId:'selection@test',pluginRoot:root,entrypoints:[entry]}])
  return runtime
}
test('real Worker ui.selection answers the current host selection without retaining an old value', async () => {
  let selected: {text:string;requestId?:string} | undefined = {text:'selected',requestId:'tool-actual'}
  const runtime = await runtimeWith({uiSelection:() => selected})
  expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:selected})
  selected = undefined
  expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:undefined})
})
test('real Worker selection is undefined when the host has no selection support', async () => {
  const runtime = await runtimeWith()
  expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:undefined})
})
test('ui.selection hook receives empty input and actual caller origin, and can return a wrapped selection', async () => {
  const runtime = await runtimeWith({uiSelection:() => ({text:'host'})}, `
    on('ui.selection',async($,e,next)=>{
      if(Object.keys(e).length!==0 || next.origin.plugin!=='selection-caller' || next.origin.tier!=='user') throw Error('wrong selection context');
      const result=await next(e);return {value:{text:result.value.text+' transformed'}};
    });`)
  expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:{text:'host transformed'}})
})
test('ui.selection denial follows the public wrapped host result path', async () => {
  const diagnostics: string[] = []
  const runtime = await runtimeWith({}, `on('ui.selection',()=>({deny:'selection refused'}));`, diagnostics)
  expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:'core'})
  expect(diagnostics.some(message => message.includes('selection refused'))).toBe(true)
})
class Output extends Writable {
  columns = 20
  rows = 4
  isTTY = false
  output = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.output += chunk.toString(); callback() }
}
test('actual Ink text reader does not copy, clear, or write, and terminal selection requires alt screen', async () => {
  const {readModUiSelection}=await import('./uiSelection.js')
  const output = new Output()
  const stdout = output as unknown as NodeJS.WriteStream
  const rendered = await render(<Text>alpha beta</Text>, {stdout,patchConsole:false,exitOnCtrlC:false})
  const ink = instances.get(stdout)!
  try {
    startSelection(ink.selection, 0, 0); updateSelection(ink.selection, 4, 0)
    const before = JSON.stringify(ink.selection), written = output.output
    expect(ink.getSelectedText()).toBe('alpha')
    expect(ink.getSelectedText()).toBe('alpha')
    expect(JSON.stringify(ink.selection)).toBe(before)
    expect(output.output).toBe(written)
    expect(readModUiSelection(ink)).toBeUndefined()
    ink.setAltScreenActive(true)
    rendered.rerender(<Text>alpha beta</Text>)
    await new Promise(resolve => setTimeout(resolve, 40))
    startSelection(ink.selection, 0, 0); updateSelection(ink.selection, 4, 0)
    expect(readModUiSelection(ink, () => 'tool-actual')).toEqual({text:'alpha',requestId:'tool-actual'})
    expect(readModUiSelection(ink, () => undefined)).toEqual({text:'alpha'})
    ink.clearTextSelection()
    expect(readModUiSelection(ink)).toBeUndefined()
  } finally { rendered.unmount() }
})
