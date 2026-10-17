import { afterEach, expect, test } from 'bun:test'
import { parse } from 'acorn'
import { readFileSync } from 'node:fs'
import {
  clearInternalWrites,
  consumeInternalWrite,
  markInternalWrite,
  settingsContentIdentity,
} from '../../utils/settings/internalWrites.js'
import { SYNC_KEYS } from './types.js'

const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
)
const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
const declaration = program.body.find(
  node => node.type === 'FunctionDeclaration' && node.id?.name === 'applyRemoteEntriesToLocal',
)!
const body = source.slice(declaration.start, declaration.end)

function harness(write: (path: string, content: string) => Promise<boolean>) {
  let resets = 0
  // Execute the production function without loading auth/network services.
  const apply = new Function(
    'SYNC_KEYS', 'MAX_FILE_SIZE_BYTES', 'logForDiagnosticsNoPII',
    'getSettingsFilePathForSource', 'markInternalWrite', 'writeFileForSync',
    'resetSettingsCache', 'getMemoryPath', 'clearMemoryFileCaches',
    `${body}; return applyRemoteEntriesToLocal`,
  )(
    SYNC_KEYS, 500 * 1024, () => {},
    (source: string) => `/isolated/${source}.json`, markInternalWrite, write,
    () => { resets++ }, () => '/isolated/memory.md', () => {},
  ) as (entries: Record<string, string>, projectId: string | null) => Promise<void>
  return { apply, resets: () => resets }
}

afterEach(clearInternalWrites)

test('settings sync records each successfully written content identity', async () => {
  const writes: [string, string][] = []
  const h = harness(async (path, content) => {
    writes.push([path, content])
    return true
  })
  const content = '{"disableAllHooks":false}\n'
  await h.apply({
    [SYNC_KEYS.USER_SETTINGS]: content,
    [SYNC_KEYS.projectSettings('project')]: '{}\n',
  }, 'project')
  expect(writes).toEqual([
    ['/isolated/userSettings.json', content],
    ['/isolated/localSettings.json', '{}\n'],
  ])
  expect(consumeInternalWrite(writes[0]![0], settingsContentIdentity(content), 5000)).toBe(true)
  expect(consumeInternalWrite(writes[1]![0], settingsContentIdentity('{}\n'), 5000)).toBe(true)
  expect(h.resets()).toBe(1)
})

test('failed settings sync writes leave no internal echo marker', async () => {
  const h = harness(async () => false)
  await h.apply({ [SYNC_KEYS.USER_SETTINGS]: '{}' }, null)
  expect(consumeInternalWrite('/isolated/userSettings.json', settingsContentIdentity('{}'), 5000)).toBe(false)
  expect(h.resets()).toBe(0)
})

test('pending settings sync does not mark bytes before the write succeeds', async () => {
  const entered = Promise.withResolvers<void>()
  const written = Promise.withResolvers<boolean>()
  const h = harness(() => {
    entered.resolve()
    return written.promise
  })
  const pending = h.apply({ [SYNC_KEYS.USER_SETTINGS]: '{}' }, null)
  // Race the operation so an early failure cannot leave the test waiting.
  await Promise.race([entered.promise, pending])
  expect(consumeInternalWrite('/isolated/userSettings.json', settingsContentIdentity('{}'), 5000)).toBe(false)
  written.resolve(true)
  await pending
  expect(consumeInternalWrite('/isolated/userSettings.json', settingsContentIdentity('{}'), 5000)).toBe(true)
})
