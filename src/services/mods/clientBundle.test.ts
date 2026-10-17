import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { buildModClientBundle } from './clientBundle.js'
import type { ModDeclaration } from './types.js'
import { SDKControlUIClientModuleResponseSchema } from '../../entrypoints/sdk/modsControlSchemas.js'

const declaration = (
  source = 'export default function View() {}\n',
): ModDeclaration => ({
  name: 'bundle',
  storageId: 'bundle@test',
  pluginRoot: '/owned/plugin',
  entrypoints: ['/owned/plugin/hooks/register.ts'],
  modules: [{ path: '/owned/plugin/hooks/surface.ts', source }],
  links: [],
  clients: [
    { path: '/owned/plugin/hooks/surface.ts', module: 'hooks/surface.ts' },
  ],
  events: [],
  calls: [],
  nextTiers: [],
  options: {},
  tier: 'user',
  fingerprint: 'owned',
})
test('client bundles use admitted snapshots and defensive copies, including the runtime and limits in their hash', () => {
  const input = declaration()
  const result = buildModClientBundle(input)!
  expect(
    SDKControlUIClientModuleResponseSchema().safeParse(result).success,
  ).toBe(true)
  expect(result.hash).toBe(
    createHash('sha256')
      .update(
        JSON.stringify({
          files: result.files,
          modules: result.modules,
          limits: result.limits,
        }),
      )
      .digest('hex'),
  )
  expect(result.limits).toEqual({
    nodes: 20000,
    depth: 32,
    chars: 100000,
    values: 20000,
    dataDepth: 32,
  })
  result.files[0]!.source = 'forged'
  result.modules[0]!.component = 'forged'
  result.limits.nodes = 1
  expect(buildModClientBundle(input)!.files[0]!.source).not.toBe('forged')
  expect(buildModClientBundle(input)!.modules[0]!.component).toBe('default')
  expect(buildModClientBundle(input)!.limits.nodes).toBe(20000)
  expect(buildModClientBundle({ ...input, clients: [] })).toBeUndefined()
})

test('rewrites static and dynamic imports in the admitted client graph, preserves cycles and blocks unknown imports', () => {
  const input = declaration(
    'import {atom} from "claude-code"; import {value} from "./helper.ts"; export default function View(){return import("./helper.ts")}\n',
  )
  input.modules.push({
    path: '/owned/plugin/hooks/helper.ts',
    source:
      'export {default as View} from "./surface.ts"; export const value = () => import("foreign");',
  })
  input.links.push(
    {
      from: input.modules[0]!.path,
      specifier: './helper.ts',
      to: input.modules[1]!.path,
    },
    {
      from: input.modules[1]!.path,
      specifier: './surface.ts',
      to: input.modules[0]!.path,
    },
  )
  const bundle = buildModClientBundle(input)!
  expect(bundle.files.map((file) => file.key)).toEqual([
    'claude:surface-runtime',
    'claude:hooks-types',
    'surface:///hooks/surface.ts',
    'surface:///hooks/helper.ts',
  ])
  expect(bundle.files[2]!.source).toContain('from "claude:hooks-types"')
  expect(bundle.files[2]!.source).toContain(
    'import("surface:///hooks/helper.ts")',
  )
  expect(bundle.files[3]!.source).toContain(
    'from "surface:///hooks/surface.ts"',
  )
  expect(bundle.files[3]!.source).toContain(
    'import("surface-unlinked:///foreign")',
  )
})

test('wraps computed imports without discarding nested import rewrites and encodes path segments', () => {
  const input = declaration(
    'export default function View(){return import(import("foreign"))}',
  )
  input.modules[0]!.path = '/owned/plugin/hooks/a b#c.ts'
  input.clients![0] = {
    path: input.modules[0]!.path,
    module: 'hooks/a b#c.ts',
  }
  const bundle = buildModClientBundle(input)!
  expect(bundle.modules[0]!.entry).toBe('surface:///hooks/a%20b%23c.ts')
  expect(bundle.files[2]!.source).toContain(
    'import(("surface-unlinked:///computed#" + String(import("surface-unlinked:///foreign"))))',
  )
})

test('selects one named component without evaluating it and rejects missing, ambiguous or unadmitted components', () => {
  expect(
    buildModClientBundle(
      declaration('export function View(){throw Error("never execute")}'),
    )!.modules[0]!.component,
  ).toBe('View')
  for (const source of [
    'export const value=1',
    'export function View(){};export function Other(){}',
  ])
    expect(() => buildModClientBundle(declaration(source))).toThrow(
      'Client module must export',
    )
  const missing = declaration()
  missing.modules = []
  expect(() => buildModClientBundle(missing)).toThrow(
    'not in the admitted snapshot',
  )
  const outside = declaration()
  outside.clients![0]!.path = '/owned/outside.ts'
  expect(() => buildModClientBundle(outside)).toThrow('outside')
})
