import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attachment } from '../../utils/attachments.js'
import { createModsRuntime } from './runtime.js'
import { dispatchModPromptMention } from './promptMention.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mods-mention-'))) })
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function load(hooks: string) {
  const entry = join(root, 'register.mjs')
  await writeFile(entry, `export function register(on) { ${hooks} }`)
  runtime = createModsRuntime({})
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'mention-fixture' })
  await runtime.reconcile([{ name: 'mentions', storageId: 'mentions@fixture', pluginRoot: root, entrypoints: [entry] }])
  return runtime.capture({})
}
const file = (path: string) => ({ type: 'file', filename: path }) as unknown as Attachment

test('prompt.mention denies a read so nothing is attached', async () => {
  const snapshot = await load(`on('prompt.mention', ($, e) => e.path.endsWith('.env') ? {deny:'a secret'} : undefined);`)
  const reads: string[] = []
  try {
    expect(await dispatchModPromptMention(snapshot, { mention: '.env', path: '/w/.env' }, async path => { reads.push(path); return file(path) }, new AbortController().signal))
      .toEqual([])
    expect(reads).toEqual([])
  } finally { snapshot.release() }
}, 20000)

test('prompt.mention reads another path, reads once, and adds context', async () => {
  const snapshot = await load(`on('prompt.mention', async ($, e, next) => {
    const first = await next({...e, path:'/w/other.ts', offset:2, limit:3})
    await next(e)
    return {...first, context:['note from mod']}
  });`)
  const reads: unknown[] = []
  try {
    const result = await dispatchModPromptMention(snapshot, { mention: 'a.ts', path: '/w/a.ts' }, async (path, offset, limit) => {
      reads.push([path, offset, limit])
      return file(path)
    }, new AbortController().signal)
    expect(reads).toEqual([['/w/other.ts', 2, 3]])
    expect(result).toEqual([file('/w/other.ts'), expect.objectContaining({ type: 'hook_additional_context', content: ['note from mod'], modEvent: 'prompt.mention' })])
  } finally { snapshot.release() }
}, 20000)

test('a prompt.mention hook that rewrites the pinned mention fails and the file is read as made', async () => {
  const snapshot = await load(`on('prompt.mention', ($, e, next) => next({...e, mention:'other'}));`)
  try {
    const result = dispatchModPromptMention(snapshot, { mention: 'a', path: '/w/a' }, async path => file(path), new AbortController().signal)
    expect(await result).toEqual([file('/w/a')])
  } finally { snapshot.release() }
}, 20000)
