import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { projectAttributionText } from './attributionText.js'
import { createModsRuntime, type ModsRuntime } from './runtime.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function runtime(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'mods-attribution-text-'))
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  const diagnostics: { stage: string }[] = []
  const mods = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
  })
  cleanups.push(async () => {
    await mods.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mods.reconcile([
    {
      name: 'fixture',
      storageId: 'fixture@inline',
      pluginRoot: root,
      entrypoints: [entry],
    },
  ])
  return { mods, diagnostics }
}

function context(
  mods: ModsRuntime,
  abortController = new AbortController(),
): Pick<ToolUseContext, 'mods' | 'abortController'> {
  return { mods, abortController }
}

describe('attribution.text projection', () => {
  test('dispatches the composed kind and text and returns rewritten text', async () => {
    const { mods, diagnostics } = await runtime(`export function register(on) {
      on('attribution.text', {kind:'commit'}, async ($, e, next) => {
        const result = await next({...e, text:e.text+' downstream'});
        return {text:result.text+' hooked'};
      });
    }`)

    expect(
      await projectAttributionText(context(mods), 'commit', 'core'),
    ).toBe('core downstream hooked')
    expect(diagnostics).toEqual([])
  })

  test('pins kind and recovers the core text after an attempted rewrite', async () => {
    const { mods, diagnostics } = await runtime(`export function register(on) {
      on('attribution.text', ($, e, next) => next({...e, kind:'pr', text:'wrong'}));
    }`)

    expect(
      await projectAttributionText(context(mods), 'commit', 'core'),
    ).toBe('core')
    expect(diagnostics.map(event => event.stage)).toEqual(['attribution.text'])
  })

  test('recovers the core text from an invalid hook result', async () => {
    const { mods, diagnostics } = await runtime(`export function register(on) {
      on('attribution.text', () => ({text:42}));
    }`)

    expect(await projectAttributionText(context(mods), 'pr', 'core')).toBe(
      'core',
    )
    expect(diagnostics.map(event => event.stage)).toEqual(['attribution.text'])
  })

  test('propagates cancellation and releases an owned snapshot', async () => {
    const { mods } = await runtime(`export function register(on) {
      on('attribution.text', ($, e, next) => new Promise((resolve, reject) => {
        next.signal.addEventListener('abort', () => reject(next.signal.reason), {once:true});
      }));
    }`)
    const capture = mods.capture
    let releases = 0
    mods.capture = services => {
      const snapshot = capture(services)
      return {
        ...snapshot,
        release() {
          releases++
          snapshot.release()
        },
      }
    }
    const abortController = new AbortController()
    const projected = projectAttributionText(
      context(mods, abortController),
      'commit',
      'core',
    )
    const reason = new Error('cancel attribution')
    abortController.abort(reason)

    const error = await projected.then(() => undefined, error => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
    expect(releases).toBe(1)
  })

  test('does not release a caller-owned snapshot', async () => {
    const { mods } = await runtime(`export function register(on) {
      on('attribution.text', ($, e, next) => next(e));
    }`)
    const snapshot = mods.capture()
    let releases = 0
    const owned = {
      ...snapshot,
      release() {
        releases++
        snapshot.release()
      },
    }
    try {
      expect(
        await projectAttributionText(
          {
            mods,
            modsSnapshot: owned,
            abortController: new AbortController(),
          },
          'remedy',
          'core',
        ),
      ).toBe('core')
      expect(releases).toBe(0)
    } finally {
      owned.release()
    }
    expect(releases).toBe(1)
  })
})
