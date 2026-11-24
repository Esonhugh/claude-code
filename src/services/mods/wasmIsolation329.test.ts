import { expect, test } from 'bun:test'
import vm from 'node:vm'

test('the shared evaluator cannot instantiate even a module compiled in isolation', async () => {
  const bytes = 'Uint8Array.of(0,97,115,109,1,0,0,0)'
  const isolated = vm.createContext({}, { codeGeneration: { strings: false, wasm: true } })
  const module = await vm.runInContext(`WebAssembly.compile(${bytes})`, isolated)
  expect(await vm.runInContext(`WebAssembly.instantiate(module).then(i => i instanceof WebAssembly.Instance)`,
    vm.createContext({module}, {codeGeneration:{strings:false,wasm:true}}))).toBe(true)
  const shared = vm.createContext({module:structuredClone(module)}, {codeGeneration:{strings:false,wasm:false}})
  expect(await vm.runInContext(`WebAssembly.instantiate(module).then(() => 'unexpected', e => e.name)`,shared)).toBe('CompileError')
})
