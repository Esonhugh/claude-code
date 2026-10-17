import { expect, test } from 'bun:test'
import {
  createModRemoteClientRegistry,
  modClientDataProblem,
} from './remoteUiClient.js'
import type {
  SDKUIClientAddress,
  SDKUIRenderElement,
} from '../../entrypoints/sdk/modsControlTypes.js'
const address: SDKUIClientAddress = {
  plugin: 'owner',
  component: 'Pane',
  instance_id: 'one',
  client: 'key',
  module: 'hooks/view.ts',
}
const tree: SDKUIRenderElement = {
  type: 'Client',
  client: { plugin: 'owner' },
  props: { key: 'key', module: 'hooks/view.ts' },
}
test('Client generations preserve old addresses until publication, ignore late draws and clear unhooked rows', () => {
  const registry = createModRemoteClientRegistry(),
    first = registry.begin('Pane', 'one')
  registry.record(first, tree)
  const older = registry.begin('Pane', 'one'),
    newer = registry.begin('Pane', 'one')
  expect(registry.has(address)).toBe(true)
  registry.record(newer, { type: 'engine', ref: 0 })
  registry.record(older, tree)
  expect(registry.has(address)).toBe(false)
})
test('Client address registry has an independent 1024-instance LRU', () => {
  const registry = createModRemoteClientRegistry()
  for (let i = 0; i < 1024; i++)
    registry.record(registry.begin('Pane', String(i)), tree)
  expect(registry.has({ ...address, instance_id: '0' })).toBe(true)
  registry.record(registry.begin('Pane', 'extra'), tree)
  expect(registry.has({ ...address, instance_id: '1' })).toBe(false)
  expect(registry.has({ ...address, instance_id: '0' })).toBe(true)
  registry.clear()
  expect(registry.has({ ...address, instance_id: '0' })).toBe(false)
})
test('Client wire data counts conservative characters, values and root-zero depth', () => {
  expect(modClientDataProblem('x'.repeat(99998))).toBeUndefined()
  expect(modClientDataProblem('x'.repeat(99999))).toBe(
    'serializes to more than 100000 characters',
  )
  expect(modClientDataProblem(Array(19999).fill(0))).toBeUndefined()
  expect(modClientDataProblem(Array(20000).fill(0))).toBe(
    'holds more than 20000 values',
  )
  let deep: unknown = null
  for (let i = 0; i < 32; i++) deep = [deep]
  expect(modClientDataProblem(deep)).toBeUndefined()
  expect(modClientDataProblem([deep])).toBe('nests deeper than 32')
  const cycle: any = {}
  cycle.self = cycle
  expect(modClientDataProblem(cycle)).toBe('holds a cycle')
  expect(modClientDataProblem(new Date())).toContain('not plain')
  expect(modClientDataProblem(new Array(2))).toContain('undefined')
  expect(modClientDataProblem(Infinity)).toBe('holds Infinity')
})
