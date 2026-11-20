import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadModDeclaration } from './loader.js'

test('the shared evaluator cannot instantiate even a module compiled in isolation', async () => {
  const bytes = 'Uint8Array.of(0,97,115,109,1,0,0,0)'
  const isolated = vm.createContext({}, { codeGeneration: { strings: false, wasm: true } })
  const module = await vm.runInContext(`WebAssembly.compile(${bytes})`, isolated)
  expect(await vm.runInContext(`WebAssembly.instantiate(module).then(i => i instanceof WebAssembly.Instance)`,
    vm.createContext({module}, {codeGeneration:{strings:false,wasm:true}}))).toBe(true)
  const shared = vm.createContext({module:structuredClone(module)}, {codeGeneration:{strings:false,wasm:false}})
  expect(await vm.runInContext(`WebAssembly.instantiate(module).then(() => 'unexpected', e => e.name)`,shared)).toBe('CompileError')
})

test('a wasm.compile caller receives a named admission error, not a nonfunctional module proxy', async () => {
  const root = await mkdtemp(join(tmpdir(),'mods-wasm-admission-'))
  try {
    const path = join(root,'entry.mjs')
    await writeFile(path, `export function register(on){on('tool.call', async $ => {
      await $.wasm.compile(new Uint8Array([0,97,115,109,1,0,0,0])); return {result:1}
    })}`)
    await expect(loadModDeclaration({pluginRoot:root,name:'probe',storageId:'probe@inline',entrypoints:[path]}))
      .rejects.toThrow('wasm.compile requires an isolated execution worker; not supported in this build')
  } finally { await rm(root,{recursive:true,force:true}) }
})
