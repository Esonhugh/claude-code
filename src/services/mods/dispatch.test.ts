import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dispatchModEvent } from './dispatch.js'
import type { ModDispatchHook, ModInput, ModNext, ModTier } from './types.js'

function hook(
  plugin: string,
  invoke: ModDispatchHook['invoke'],
  options: {
    tier?: ModTier
    event?: string
    hasCatch?: boolean
    id?: number
    matcher?: ModDispatchHook['registration']['matcher']
  } = {},
): ModDispatchHook {
  return {
    plugin,
    tier: options.tier ?? 'user',
    registration: {
      id: options.id ?? 0,
      event: options.event ?? 'tool.call',
      hasCatch: options.hasCatch ?? false,
      matcher: options.matcher,
    },
    invoke,
  }
}

const input: ModInput = {
  tool: 'Bash',
  tool_use_id: 'call-1',
  agentId: 'agent-1',
  input: {},
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('ordinary mod dispatch', () => {
  it('next.is shares exact, glob and negated matching in normal and catch handlers', async () => {
    const phases: boolean[] = []
    const matches: boolean[][] = []
    await dispatchModEvent({event:'tool.call',input,
      hooks:[hook('patterns',async (e,next,catching)=>{
        phases.push(catching)
        matches.push(['tool.call','tool.*','*','!tool.list','!session.*','tool.list','session.*','!tool.call','!tool.*','!*','invalid'].map(pattern=>next.is(pattern,e)))
        if (!catching) throw Error('enter catch')
        return next(e)
      },{hasCatch:true})],core:async()=>({result:'core'}),
    })
    assert.deepEqual(phases,[false,true])
    assert.deepEqual(matches,[0,1].map(()=>[true,true,true,true,true,false,false,false,false,false,false]))
  })
  it('validates rewritten input before any downstream short circuit and restores command presentation', async () => {
    const initial = { command: 'diff', args: '', origin: { kind: 'composer' }, presentation: { columns: 80, isFullscreen: false } }
    for (const changed of [
      { ...initial, command: 'other' },
      { ...initial, origin: { kind: 'sdk' } },
      { ...initial, presentation: { columns: 140, isFullscreen: false } },
    ]) {
      const seen: ModInput[] = []
      const failures: unknown[] = []
      await dispatchModEvent({ event: 'command.run', input: initial,
        hooks: [hook('rewrite', async (_e, next) => next(changed), { event: 'command.run' }),
          hook('short', async e => { seen.push(e); return {} }, { event: 'command.run' })],
        core: async () => { throw Error('core must not run') },
        onFailure: (_plugin, error) => failures.push(error),
      })
      assert.deepEqual(seen, [initial])
      assert.equal(failures.length, 1)
    }
    let received: ModInput | undefined
    await dispatchModEvent({ event: 'command.run', input: initial,
      hooks: [hook('omit', async (e, next) => next({ command: e.command, args: e.args, origin: structuredClone(e.origin) }), { event: 'command.run' }),
        hook('short', async e => { received = e; return {} }, { event: 'command.run' })], core: async () => ({}),
    })
    assert.deepEqual(received, initial)
  })

  it('runs the per-event input validator at each next boundary, including bypassed core', async () => {
    const seen: ModInput[] = []
    const failure: unknown[] = []
    const result = await dispatchModEvent({ event: 'prompt.submit', input: { text: 'text', context: ['one', 'one'] },
      hooks: [hook('drop', async (e, next) => next({ ...e, context: ['one'] }), { event: 'prompt.submit' }),
        hook('short', async e => { seen.push(e); return { text: e.text, context: e.context } }, { event: 'prompt.submit' })],
      validateInput: (rewritten, received) => { assert.deepEqual(rewritten.context, received.context) },
      onFailure: (_plugin, error) => failure.push(error), core: async () => { throw Error('core must not run') },
    })
    assert.deepEqual(result, { text: 'text', context: ['one', 'one'] })
    assert.equal(failure.length, 1)
    assert.deepEqual(seen, [{ text: 'text', context: ['one', 'one'] }])
  })
  it('validates against every resolved next result of the current link', async () => {
    const first = { value: 'first' }
    const second = { value: 'second' }
    const answer = { value: 'answer' }
    const validations: [unknown, readonly unknown[]][] = []
    let effects = 0
    const result = await dispatchModEvent({
      event: 'example.call',
      input: {},
      hooks: [
        hook('outer', async (e, next) => {
          await next(e)
          await next(e)
          return answer
        }, { event: 'example.call' }),
        hook('inner', async (e, next) => next(e), { event: 'example.call' }),
      ],
      core: async () => (++effects === 1 ? first : second),
      validateResult: (value, nextResults) => {
        validations.push([value, nextResults])
      },
    })
    assert.equal(result, answer)
    assert.equal(effects, 2)
    assert.deepEqual(validations, [
      [first, [first]],
      [second, [second]],
      [answer, [first, second]],
    ])
    assert.equal(validations[2]![1][0], first)
    assert.equal(validations[2]![1][1], second)
  })

  it('validates catch results against all resolved next calls without replaying effects', async () => {
    for (const called of [false, true]) {
      const validations: [unknown, readonly unknown[]][] = []
      let effects = 0
      const result = await dispatchModEvent({
        event: 'example.call',
        input: {},
        hooks: [hook('recover', async (e, next, catching) => {
          if (!catching) {
            if (called) {
              await next(e)
              await next(e)
            }
            throw new Error('recover')
          }
          const first = next(e)
          const replay = next({ ignored: true })
          assert.equal(first, replay)
          await first
          await replay
          return 'caught'
        }, { event: 'example.call', hasCatch: true })],
        core: async () => ++effects,
        validateResult: (value, nextResults) => {
          validations.push([value, [...nextResults]])
        },
      })
      assert.equal(result, 'caught')
      assert.equal(effects, called ? 2 : 1)
      assert.deepEqual(validations, [['caught', called ? [1, 2, 2, 2] : [1, 1]]])
    }
  })

  it('pins every plugin.register envelope field before continuing', async () => {
    const admission: ModInput = {
      name: 'candidate',
      tier: 'user',
      root: '/plugins/candidate',
      provenance: 'candidate@inline',
      version: '1.0.0',
      uses: { events: ['tool.call'], calls: ['fs.read'], env: { reads: ['HOME'], writes: [] } },
    }
    for (const field of ['name', 'tier', 'root', 'provenance', 'version', 'uses']) {
      for (const action of ['change', 'omit']) {
        if (field === 'version' && action === 'omit') continue
        let effects = 0
        let checked = false
        const failures: unknown[] = []
        const result = await dispatchModEvent({
          event: 'plugin.register',
          input: admission,
          hooks: [hook('judge', async (e, next) => {
            const rewritten = { ...e, [field]: 'changed' }
            if (action === 'omit') delete rewritten[field]
            await assert.rejects(next(rewritten), new RegExp(`${field}.*plugin.register`))
            checked = true
            return next(e)
          }, { event: 'plugin.register' })],
          core: async (e) => {
            effects++
            assert.deepEqual(e, admission)
            return { allow: true }
          },
          onFailure: (_plugin, error) => { failures.push(error) },
        })
        assert.deepEqual(result, { allow: true })
        assert.ok(checked, `${action} ${field}`)
        assert.equal(effects, 1)
        assert.deepEqual(failures, [])
      }
    }
  })

  it('restores only an omitted plugin.register version and accepts cloned uses', async () => {
    for (const version of [undefined, '1.0.0']) {
      const uses = { events: ['tool.call'], calls: [], env: { reads: ['HOME'], writes: [] } }
      const admission: ModInput = {
        name: 'candidate', tier: 'user', root: '/plugins/candidate',
        provenance: 'candidate@inline', uses,
        ...(version === undefined ? {} : { version }),
      }
      const failures: unknown[] = []
      let rewritten!: ModInput
      let received!: ModInput
      const result = await dispatchModEvent({
        event: 'plugin.register',
        input: admission,
        hooks: [hook('judge', async (e, next) => {
          rewritten = { ...e, uses: structuredClone(uses) }
          delete rewritten.version
          return next(rewritten)
        }, { event: 'plugin.register' })],
        core: async e => {
          received = e
          return { allow: true }
        },
        onFailure: (_plugin, error) => { failures.push(error) },
      })
      assert.deepEqual(result, { allow: true })
      assert.deepEqual(received, admission)
      assert.notEqual(received.uses, uses)
      assert.equal(Object.hasOwn(received, 'version'), version !== undefined)
      assert.equal(Object.hasOwn(rewritten, 'version'), false)
      assert.deepEqual(failures, [])
    }
  })

  it('attributes engine.create descendant failures only to the hook that failed', async () => {
    for (const rethrow of [false, true]) {
      for (const failure of [new Error('inner failed'), 'inner failed', undefined]) {
        const failures: [string, unknown][] = []
        let effects = 0
        let catches = 0
        let rethrows = 0
        let observed: unknown = Symbol('not rejected')
        await dispatchModEvent({
          event: 'engine.create',
          input: {},
          hooks: [
            hook('outer', async (e, next) => next(e), { event: 'engine.create' }),
            hook('middle', async (e, next) => {
              if (!rethrow) return next(e)
              try {
                return await next(e)
              } catch (error) {
                rethrows++
                throw error
              }
            }, { event: 'engine.create' }),
            hook('broken', async (_e, _next, catching) => {
              if (catching) catches++
              throw failure
            }, { event: 'engine.create', hasCatch: true }),
          ],
          core: async () => ++effects,
          onFailure: (plugin, error) => { failures.push([plugin, error]) },
        }).catch(error => { observed = error })
        assert.equal(observed, failure)
        assert.deepEqual(failures, [['broken', failure]])
        assert.equal(effects, 0)
        assert.equal(catches, 0)
        assert.equal(rethrows, rethrow ? 1 : 0)
      }
    }
  })

  it('compares plugin.register uses to the original structure even after in-place edits', async () => {
    const original = { events: ['tool.call'], calls: ['fs.read'], env: { reads: ['HOME'], writes: [] } }
    const failures: unknown[] = []
    let checked = false
    let effects = 0
    const result = await dispatchModEvent({
      event: 'plugin.register',
      input: {
        name: 'candidate', tier: 'user', root: '/plugins/candidate',
        provenance: 'candidate@inline', uses: structuredClone(original),
      },
      hooks: [hook('judge', async (e, next) => {
        const uses = e.uses as typeof original
        uses.env.reads.push('OTHER')
        await assert.rejects(next(e), /uses.*plugin.register/)
        uses.env.reads.pop()
        checked = true
        return next({ ...e, uses: { env: uses.env, calls: uses.calls, events: uses.events } })
      }, { event: 'plugin.register' })],
      core: async () => {
        effects++
        return { allow: true }
      },
      onFailure: (_plugin, error) => { failures.push(error) },
    })
    assert.deepEqual(result, { allow: true })
    assert.ok(checked)
    assert.equal(effects, 1)
    assert.deepEqual(failures, [])
  })

  it('collects concurrent next results on settlement and excludes rejected or pending calls', async () => {
    const slow = deferred<unknown>()
    const failure = new Error('branch rejected')
    const first = { branch: 'slow' }
    const second = { branch: 'fast' }
    const validations: [unknown, readonly unknown[]][] = []
    let pending!: Promise<unknown>
    const result = await dispatchModEvent({
      event: 'example.call',
      input: {},
      hooks: [hook('concurrent', async (e, next) => {
        const earlier = next({ ...e, branch: 'slow' })
        await next({ ...e, branch: 'fast' })
        await assert.rejects(next({ ...e, branch: 'reject' }), error => error === failure)
        await next({ ...e, branch: 'void' })
        slow.resolve(first)
        await earlier
        pending = next({ ...e, branch: 'pending' })
        return 'answer'
      }, { event: 'example.call' })],
      core: async e => {
        if (e.branch === 'slow') return slow.promise
        if (e.branch === 'reject') throw failure
        if (e.branch === 'pending') return new Promise(() => {})
        return e.branch === 'fast' ? second : undefined
      },
      validateResult: (value, nextResults) => { validations.push([value, [...nextResults]]) },
    })
    assert.equal(result, 'answer')
    assert.deepEqual(validations, [['answer', [second, undefined, first]]])
    await assert.rejects(pending)
  })

  it('retains resolved next results when validation fails and catch recovers', async () => {
    const below = { value: 'below' }
    const failure = new Error('validator refused')
    const validations: [unknown, readonly unknown[]][] = []
    const failures: [string, unknown][] = []
    let effects = 0
    const result = await dispatchModEvent({
      event: 'example.call',
      input: {},
      hooks: [hook('recover', async (e, next, catching) => {
        if (catching) return next(e)
        await next(e)
        return 'invalid'
      }, { event: 'example.call', hasCatch: true })],
      core: async () => { effects++; return below },
      validateResult: (value, nextResults) => {
        validations.push([value, [...nextResults]])
        if (value === 'invalid') throw failure
      },
      onFailure: (plugin, error) => { failures.push([plugin, error]) },
    })
    assert.equal(result, below)
    assert.equal(effects, 1)
    assert.deepEqual(validations, [['invalid', [below]], [below, [below, below]]])
    assert.deepEqual(failures, [['recover', failure]])
  })

  it('passes an empty next result list when an ordinary or catch hook short-circuits', async () => {
    for (const catching of [false, true]) {
      const validations: [unknown, readonly unknown[]][] = []
      let effects = 0
      const result = await dispatchModEvent({
        event: 'example.call',
        input: {},
        hooks: [hook('short-circuit', async (_e, _next, isCatch) => {
          if (catching && !isCatch) throw new Error('recover')
          return 'answer'
        }, { event: 'example.call', hasCatch: catching })],
        core: async () => ++effects,
        validateResult: (value, nextResults) => { validations.push([value, [...nextResults]]) },
      })
      assert.equal(result, 'answer')
      assert.deepEqual(validations, [['answer', []]])
      assert.equal(effects, 0)
    }
  })

  it('does not restore an explicitly undefined or null plugin.register version', async () => {
    for (const version of [undefined, null]) {
      const failures: unknown[] = []
      let checked = false
      let effects = 0
      const result = await dispatchModEvent({
        event: 'plugin.register',
        input: {
          name: 'candidate', tier: 'user', root: '/plugins/candidate',
          provenance: 'candidate@inline', version: '1.0.0', uses: { events: [], calls: [] },
        },
        hooks: [hook('judge', async (e, next) => {
          await assert.rejects(next({ ...e, version }), /version.*plugin.register/)
          checked = true
          return { refuse: 'not admitted' }
        }, { event: 'plugin.register' })],
        core: async () => { effects++; return { allow: true } },
        onFailure: (_plugin, error) => { failures.push(error) },
      })
      assert.deepEqual(result, { refuse: 'not admitted' })
      assert.ok(checked)
      assert.equal(effects, 0)
      assert.deepEqual(failures, [])
    }
  })

  it('attributes new engine.create errors after handled descendant failures independently', async () => {
    const innerFailure = new Error('same message')
    const outerFailure = new Error('same message')
    const failures: [string, unknown][] = []
    await assert.rejects(dispatchModEvent({
      event: 'engine.create',
      input: {},
      hooks: [
        hook('pass', async (e, next) => next(e), { event: 'engine.create' }),
        hook('outer', async (e, next) => {
          await assert.rejects(next(e), error => error === innerFailure)
          throw outerFailure
        }, { event: 'engine.create' }),
        hook('inner', async () => { throw innerFailure }, { event: 'engine.create' }),
      ],
      core: async () => ({}),
      onFailure: (plugin, error) => { failures.push([plugin, error]) },
    }), error => error === outerFailure)
    assert.deepEqual(failures, [['inner', innerFailure], ['outer', outerFailure]])
  })

  it('keeps engine.create failure attribution local to each downstream call', async () => {
    const failure = new Error('reused failure')
    const failures: [string, unknown][] = []
    let calls = 0
    await assert.rejects(dispatchModEvent({
      event: 'engine.create',
      input: {},
      hooks: [
        hook('outer', async (e, next) => {
          await assert.rejects(next(e), error => error === failure)
          return next(e)
        }, { event: 'engine.create' }),
        hook('inner', async () => { calls++; throw failure }, { event: 'engine.create' }),
      ],
      core: async () => ({}),
      onFailure: (plugin, error) => { failures.push([plugin, error]) },
    }), error => error === failure)
    assert.equal(calls, 2)
    assert.deepEqual(failures, [['inner', failure], ['inner', failure]])
  })

  it('attributes engine.create result and next argument validation to their own hook', async () => {
    for (const invalidNext of [false, true]) {
      const failure = new Error('invalid result')
      const failures: [string, unknown][] = []
      await assert.rejects(dispatchModEvent({
        event: 'engine.create',
        input: {},
        hooks: [
          hook('outer', async (e, next) => next(e), { event: 'engine.create' }),
          hook('broken', async (e, next) => {
            if (invalidNext) return next(null as unknown as ModInput)
            return next(e)
          }, { event: 'engine.create' }),
        ],
        core: async () => ({}),
        validateResult: () => { throw failure },
        onFailure: (plugin, error) => { failures.push([plugin, error]) },
      }), invalidNext ? /next requires an input object/ : error => error === failure)
      assert.equal(failures.length, 1)
      assert.equal(failures[0]![0], 'broken')
    }
  })

  it('does not attribute engine.create core errors or parent aborts to passing hooks', async () => {
    for (const cancel of [false, true]) {
      const parent = new AbortController()
      const failure = new Error('core stopped')
      const failures: [string, unknown][] = []
      let validations = 0
      await assert.rejects(dispatchModEvent({
        event: 'engine.create',
        input: {},
        signal: parent.signal,
        hooks: [hook('pass', async (e, next) => next(e), { event: 'engine.create' })],
        core: async () => {
          if (cancel) parent.abort(failure)
          throw failure
        },
        validateResult: () => { validations++ },
        onFailure: (plugin, error) => { failures.push([plugin, error]) },
      }), error => error === failure)
      assert.deepEqual(failures, [])
      assert.equal(validations, 0)
    }
  })

  it('runs downstream and core afresh for each ordinary next call', async () => {
    let effects = 0
    let below = 0
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('outer', async (e, next) => [await next(e), await next(e)]),
        hook('inner', async (e, next) => {
          below++
          return next(e)
        }),
      ],
      core: async () => ++effects,
    })
    assert.deepEqual(result, [1, 2])
    assert.equal(effects, 2)
    assert.equal(below, 2)
  })

  it('recovers a failed hook using its last downstream call without repeating effects', async () => {
    let effects = 0
    const failure = new Error('after next')
    const failures: unknown[] = []
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('broken', async (e, next) => {
          await next(e)
          throw failure
        }),
      ],
      core: async () => ++effects,
      onFailure: (plugin, error) => {
        failures.push([plugin, error])
      },
    })
    assert.equal(result, 1)
    assert.equal(effects, 1)
    assert.deepEqual(failures, [['broken', failure]])
  })

  it('catch replays a prior next, or starts downstream only once if uncalled', async () => {
    for (const called of [false, true]) {
      let effects = 0
      const result = await dispatchModEvent({
        event: 'tool.call',
        input,
        hooks: [
          hook(
            'recover',
            async (e, next, catching) => {
              if (!catching) {
                assert.equal(next.error, undefined)
                assert.equal(next.called, undefined)
                if (called) await next(e)
                throw new Error('broken')
              }
              assert.equal(next.called, called)
              assert.deepEqual(next.error, {
                kind: 'throw',
                message: 'broken',
                budget: 1000,
              })
              assert.ok(Object.isFrozen(next.error))
              const first = next(e)
              const replay = next({ ignored: true })
              assert.equal(first, replay)
              assert.equal(await first, 1)
              assert.equal(await replay, 1)
              assert.equal(next.called, called)
              return 'caught'
            },
            { hasCatch: true },
          ),
        ],
        core: async () => ++effects,
      })
      assert.equal(result, 'caught')
      assert.equal(effects, 1)
    }
  })

  it('recovers the last-started branch rather than the last to settle', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const failed = deferred<void>()
    let effects = 0
    const result = dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook(
          'concurrent',
          async (e, next, catching) => {
            if (catching) return next(e)
            void next(e)
            void next(e)
            throw new Error('recover last')
          },
          { hasCatch: true },
        ),
      ],
      core: async () => (++effects === 1 ? first.promise : second.promise),
      onFailure: () => failed.resolve(),
    })
    await failed.promise
    second.resolve('second')
    assert.equal(await result, 'second')
    first.resolve('first')
    assert.equal(effects, 2)
  })

  it('propagates a downstream rejection unless catch returns a valid answer', async () => {
    for (const recovery of ['none', 'undefined', 'throw', 'answer']) {
      const failure = new Error('core rejected')
      let effects = 0
      const result = dispatchModEvent({
        event: 'tool.call',
        input,
        hooks: [
          hook(
            'outer',
            async (e, next, catching) => {
              if (!catching) return next(e)
              await assert.rejects(
                next({ ignored: true }),
                (error) => error === failure,
              )
              if (recovery === 'throw') throw new Error('catch rejected')
              return recovery === 'answer' ? 'recovered' : undefined
            },
            { hasCatch: recovery !== 'none' },
          ),
        ],
        core: async () => {
          effects++
          throw failure
        },
      })
      if (recovery === 'answer') assert.equal(await result, 'recovered')
      else await assert.rejects(result, (error) => error === failure)
      assert.equal(effects, 1)
    }
  })

  it('rejects undefined and validator-refused hook results, including catch results', async () => {
    for (const value of [undefined, 'invalid']) {
      let effects = 0
      const failures: unknown[] = []
      const result = await dispatchModEvent({
        event: 'tool.call',
        input,
        hooks: [hook('invalid', async () => value, { hasCatch: true })],
        core: async () => {
          effects++
          return 'valid'
        },
        validateResult: (result) => {
          assert.equal(result, 'valid')
        },
        onFailure: (_plugin, error) => {
          failures.push(error)
        },
      })
      assert.equal(result, 'valid')
      assert.equal(effects, 1)
      assert.ok(failures.length >= 1)
    }
  })

  it('times out an ignored hook, aborts its signal, and prevents late next calls', async () => {
    let lateNext!: ModNext
    let effects = 0
    let catches = 0
    const never = deferred<unknown>()
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      budgetMs: 5,
      catchGraceMs: 15,
      hooks: [
        hook(
          'slow',
          async (_e, next, catching) => {
            if (catching) {
              catches++
              assert.deepEqual(next.error, { kind: 'timeout', budget: 15 })
              return undefined
            }
            lateNext = next
            return never.promise
          },
          { hasCatch: true },
        ),
      ],
      core: async () => ++effects,
    })
    assert.equal(result, 1)
    assert.equal(catches, 1)
    assert.ok(lateNext.signal.aborted)
    await assert.rejects(lateNext(input))
    assert.equal(effects, 1)
    never.resolve('too late')
  })

  it('parent abort skips catch and does not wait for an ignored hook or core', async () => {
    for (const withHook of [true, false]) {
      const parent = new AbortController()
      const started = deferred<void>()
      const never = deferred<unknown>()
      const reason = new Error('parent cancelled')
      let catches = 0
      let effects = 0
      let nextSignal: AbortSignal | undefined
      const result = dispatchModEvent({
        event: 'tool.call',
        input,
        signal: parent.signal,
        hooks: withHook
          ? [
              hook(
                'ignores-abort',
                async (_e, next, catching) => {
                  if (catching) catches++
                  nextSignal = next.signal
                  started.resolve()
                  return never.promise
                },
                { hasCatch: true },
              ),
            ]
          : [],
        core: async () => {
          effects++
          started.resolve()
          return never.promise
        },
      })
      await started.promise
      parent.abort(reason)
      await assert.rejects(result, (error) => error === reason)
      assert.equal(catches, 0)
      assert.equal(effects, withHook ? 0 : 1)
      if (nextSignal) assert.ok(nextSignal.aborted)
      never.resolve('late')
    }
  })

  it('matches exact events and literal fields against each rewritten branch', async () => {
    const seen: string[] = []
    const observe = (name: string) => async (e: ModInput, next: ModNext) => {
      seen.push(name)
      return next(e)
    }
    await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('rewrite', async (e, next) => next({ ...e, mode: 'new' })),
        hook('glob-event', observe('glob-event'), { event: 'tool.*' }),
        hook('wrong-event', observe('wrong-event'), {
          event: 'tool.call.extra',
        }),
        hook('glob-value', observe('glob-value'), { matcher: { tool: 'Ba*' } }),
        hook('literal', observe('literal'), {
          matcher: { tool: 'Bash', mode: 'new' },
        }),
        hook('wrong-type', observe('wrong-type'), { matcher: { mode: 1 } }),
      ],
      core: async (e) => {
        seen.push('core')
        return e
      },
    })
    assert.deepEqual(seen, ['glob-event', 'literal', 'core'])
  })

  it('orders tiers stably and next.to preserves peers while accumulating strict skips', async () => {
    const seen: string[] = []
    const observe = (name: string) => async (e: ModInput, next: ModNext) => {
      seen.push(name)
      return next(e)
    }
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('user', observe('user')),
        hook('append', observe('append'), { tier: 'append' }),
        hook('builtin', observe('builtin'), { tier: 'builtin' }),
        hook(
          'first',
          async (e, next) => {
            seen.push('first')
            return next.to(e, 'builtin')
          },
          { tier: 'prepend' },
        ),
        hook(
          'second',
          async (e, next) => {
            seen.push('second')
            return next.to(e, 'append')
          },
          { tier: 'prepend' },
        ),
      ],
      core: async () => {
        seen.push('core')
        return 'ok'
      },
    })
    assert.equal(result, 'ok')
    assert.deepEqual(seen, ['first', 'second', 'builtin', 'core'])
  })

  it('pins tool.call identity while allowing rewritten arguments', async () => {
    for (const field of ['tool', 'tool_use_id', 'agentId']) {
      let effects = 0
      const result = await dispatchModEvent({
        event: 'tool.call',
        input,
        hooks: [
          hook('rewrite', async (e, next) => {
            await assert.rejects(
              next({ ...e, [field]: 'changed' }),
              new RegExp(field),
            )
            return next({ ...e, input: { command: 'true' } })
          }),
        ],
        core: async (e) => {
          effects++
          return e
        },
      })
      assert.deepEqual(result, { ...input, input: { command: 'true' } })
      assert.equal(effects, 1)
    }
  })

  it('engine.create propagates hook failures without catch or automatic recovery', async () => {
    const failure = new Error('rebuild fold')
    let effects = 0
    let catches = 0
    await assert.rejects(
      dispatchModEvent({
        event: 'engine.create',
        input: {},
        origin: { plugin: 'builder', tier: 'user' },
        hooks: [
          hook(
            'builder',
            async (_e, _next, catching) => {
              if (catching) catches++
              throw failure
            },
            { event: 'engine.create', hasCatch: true },
          ),
        ],
        core: async () => ++effects,
      }),
      (error) => error === failure,
    )
    assert.equal(effects, 0)
    assert.equal(catches, 0)
  })

  it('skips the origin plugin by default or only the explicit registration', async () => {
    for (const skip of [
      undefined,
      { plugin: 'self', registrationId: 1 },
      { plugin: 'other' },
    ]) {
      const seen: string[] = []
      const observe = (name: string) => async (e: ModInput, next: ModNext) => {
        seen.push(name)
        return next(e)
      }
      await dispatchModEvent({
        event: 'tool.call',
        input,
        origin: { plugin: 'self', tier: 'user' },
        skip,
        hooks: [
          hook('self', observe('self-1'), { id: 1 }),
          hook('self', observe('self-2'), { id: 2 }),
          hook('other', observe('other')),
        ],
        core: async () => 'ok',
      })
      assert.deepEqual(
        seen,
        skip?.registrationId === 1
          ? ['self-2', 'other']
          : skip
            ? ['self-1', 'self-2']
            : ['other'],
      )
    }
  })

  it('exposes frozen metadata and the latest-started branch trace, even on rejection', async () => {
    const first = deferred<string>()
    const failure = new Error('second failed')
    let effects = 0
    let outer!: ModNext
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('outer', async (e, next) => {
          outer = next
          assert.equal(next.event, 'tool.call')
          assert.deepEqual(next.origin, { plugin: 'engine', tier: 'core' })
          assert.equal(next.trace.length, 0)
          const earlier = next({ ...e, branch: 1 })
          await assert.rejects(
            next({ ...e, branch: 2 }),
            (error) => error === failure,
          )
          assert.deepEqual(
            next.trace.map((entry) => [entry.plugin, entry.outcome]),
            [
              ['inner', 'rejected'],
              ['engine', 'rejected'],
            ],
          )
          first.resolve('first')
          await earlier
          assert.ok(
            next.trace.every(
              (entry) => (entry.received as ModInput).branch === 2,
            ),
          )
          assert.ok(Object.isFrozen(next))
          assert.ok(Object.isFrozen(next.origin))
          assert.ok(Object.isFrozen(next.trace))
          assert.ok(next.trace.every(Object.isFrozen))
          return 'handled'
        }),
        hook('inner', async (e, next) => next(e)),
      ],
      core: async () => {
        if (++effects === 1) return first.promise
        throw failure
      },
    })
    assert.equal(result, 'handled')
    assert.equal(outer.trace.length, 2)
  })

  it('pauses the own budget until every concurrent downstream call settles', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const started = deferred<void>()
    let effects = 0
    const failures: unknown[] = []
    const result = dispatchModEvent({
      event: 'tool.call',
      input,
      budgetMs: 10,
      hooks: [
        hook('concurrent', async (e, next) => {
          const a = next(e)
          const b = next(e)
          started.resolve()
          return (await Promise.all([a, b])).join(',')
        }),
      ],
      core: async () => (++effects === 1 ? first.promise : second.promise),
      onFailure: (_plugin, error) => {
        failures.push(error)
      },
    })
    await started.promise
    first.resolve('first')
    await new Promise((resolve) => setTimeout(resolve, 30))
    second.resolve('second')
    assert.equal(await result, 'first,second')
    assert.deepEqual(failures, [])
    assert.equal(effects, 2)
  })

  it('starts catch grace only after the last existing downstream call settles', async () => {
    const below = deferred<string>()
    const failed = deferred<void>()
    let catches = 0
    const result = dispatchModEvent({
      event: 'tool.call',
      input,
      budgetMs: 5,
      catchGraceMs: 5,
      hooks: [
        hook(
          'pending',
          async (e, next, catching) => {
            if (catching) {
              catches++
              return `${await next(e)} caught`
            }
            void next(e)
            throw new Error('while pending')
          },
          { hasCatch: true },
        ),
      ],
      core: async () => below.promise,
      onFailure: () => failed.resolve(),
    })
    await failed.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(catches, 0)
    below.resolve('below')
    assert.equal(await result, 'below caught')
    assert.equal(catches, 1)
  })

  it('bounds an ignored catch and reuses its downstream call on grace expiry', async () => {
    let effects = 0
    let lateCatch!: ModNext
    const never = deferred<unknown>()
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      catchGraceMs: 5,
      hooks: [
        hook(
          'catch-timeout',
          async (e, next, catching) => {
            if (!catching) throw new Error('failed')
            lateCatch = next
            await next(e)
            return never.promise
          },
          { hasCatch: true },
        ),
      ],
      core: async () => ++effects,
    })
    assert.equal(result, 1)
    assert.equal(effects, 1)
    assert.ok(lateCatch.signal.aborted)
    await assert.rejects(lateCatch(input))
    assert.equal(effects, 1)
    never.resolve('late')
  })

  it('reports timeout with the last downstream rejection message', async () => {
    const failure = new Error('below refused')
    let catches = 0
    const never = deferred<unknown>()
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      budgetMs: 5,
      catchGraceMs: 10,
      hooks: [
        hook(
          'timeout-after-reject',
          async (e, next, catching) => {
            if (catching) {
              catches++
              assert.deepEqual(next.error, {
                kind: 'timeout',
                message: failure.message,
                budget: 10,
              })
              return 'recovered'
            }
            await next(e).catch(() => {})
            return never.promise
          },
          { hasCatch: true },
        ),
      ],
      core: async () => {
        throw failure
      },
    })
    assert.equal(result, 'recovered')
    assert.equal(catches, 1)
    never.resolve('late')
  })

  it('does not permit stale next after a normal return and abandons pending descendants', async () => {
    const started = deferred<void>()
    const never = deferred<unknown>()
    let lateNext!: ModNext
    let descendant!: ModNext
    let effects = 0
    let pending!: Promise<unknown>
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('outer', async (e, next) => {
          lateNext = next
          pending = next(e)
          await started.promise
          return 'own answer'
        }),
        hook('inner', async (_e, next) => {
          descendant = next
          started.resolve()
          return never.promise
        }),
      ],
      core: async () => ++effects,
    })
    assert.equal(result, 'own answer')
    await assert.rejects(pending)
    await assert.rejects(lateNext(input))
    await assert.rejects(descendant(input))
    assert.ok(descendant.signal.aborted)
    assert.equal(effects, 0)
    never.resolve('late')
  })

  it('does not start hooks or core for an already aborted dispatch', async () => {
    const parent = new AbortController()
    const reason = new Error('cancelled first')
    parent.abort(reason)
    let effects = 0
    await assert.rejects(
      dispatchModEvent({
        event: 'tool.call',
        input,
        signal: parent.signal,
        hooks: [hook('never', async () => ++effects)],
        core: async () => ++effects,
      }),
      (error) => error === reason,
    )
    assert.equal(effects, 0)
  })

  it('rejects unauthorized tier targets and keeps append peers when skipping to core', async () => {
    for (const tier of ['user', 'builtin', 'core'] as const) {
      let checked = false
      const result = await dispatchModEvent({
        event: 'tool.call',
        input,
        hooks: [
          hook(
            'unmanaged',
            async (e, next) => {
              await assert.rejects(next.to(e, 'core'), /cannot continue/)
              checked = true
              return next(e)
            },
            { tier },
          ),
        ],
        core: async () => 'ok',
      })
      assert.equal(result, 'ok')
      assert.ok(checked)
    }
    const seen: string[] = []
    await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook(
          'append-1',
          async (e, next) => {
            seen.push('a1')
            return next.to(e, 'core')
          },
          { tier: 'append' },
        ),
        hook(
          'append-2',
          async (e, next) => {
            seen.push('a2')
            return next(e)
          },
          { tier: 'append' },
        ),
        hook(
          'builtin',
          async (e, next) => {
            seen.push('builtin')
            return next(e)
          },
          { tier: 'builtin' },
        ),
      ],
      core: async () => {
        seen.push('core')
        return 'ok'
      },
    })
    assert.deepEqual(seen, ['a1', 'a2', 'core'])
  })

  it('session.start returns observation data without changing core session cwd', async () => {
    const session = { cwd: '/original' }
    let effects = 0
    const result = await dispatchModEvent({
      event: 'session.start',
      input: { cwd: session.cwd },
      hooks: [
        hook(
          'observer',
          async (e, next) => {
            await next(e)
            return { cwd: '/observation-only' }
          },
          { event: 'session.start' },
        ),
      ],
      core: async () => {
        effects++
        return { cwd: session.cwd }
      },
      validateResult: (value) => {
        assert.equal(typeof (value as { cwd: unknown }).cwd, 'string')
      },
    })
    assert.deepEqual(result, { cwd: '/observation-only' })
    assert.equal(session.cwd, '/original')
    assert.equal(effects, 1)
  })

  it('engine.create has no ordinary own-time budget', async () => {
    const finish = deferred<string>()
    let lateNext!: ModNext
    const started = deferred<void>()
    const result = dispatchModEvent({
      event: 'engine.create',
      input: {},
      budgetMs: 1,
      hooks: [
        hook(
          'builder',
          async (_e, next) => {
            lateNext = next
            started.resolve()
            return finish.promise
          },
          { event: 'engine.create' },
        ),
      ],
      core: async () => 'core',
    })
    await started.promise
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(lateNext.signal.aborted, false)
    finish.resolve('built')
    assert.equal(await result, 'built')
  })

  it('traces tier bypasses in place without losing origin on next.to', async () => {
    let observed = false
    const origin = { plugin: 'raiser', tier: 'prepend' as const }
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      origin,
      hooks: [
        hook(
          'managed',
          async (e, next) => {
            const result = await next.to(e, 'core')
            assert.deepEqual(next.origin, origin)
            assert.deepEqual(
              next.trace.map((entry) => [entry.plugin, entry.outcome]),
              [
                ['user', 'skipped'],
                ['append', 'skipped'],
                ['builtin', 'skipped'],
                ['engine', 'returned'],
              ],
            )
            observed = true
            return result
          },
          { tier: 'prepend' },
        ),
        ...(['user', 'append', 'builtin'] as const).map((tier) =>
          hook(tier, async () => 'wrong', { tier }),
        ),
      ],
      core: async () => 'core',
    })
    assert.equal(result, 'core')
    assert.ok(observed)
  })

  it('resumes own time after downstream settles and keeps effects on timeout', async () => {
    let effects = 0
    const never = deferred<unknown>()
    let activeNext!: ModNext
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      budgetMs: 5,
      hooks: [
        hook('slow-after-next', async (e, next) => {
          activeNext = next
          await next(e)
          return never.promise
        }),
      ],
      core: async () => ++effects,
    })
    assert.equal(result, 1)
    assert.equal(effects, 1)
    assert.ok(activeNext.signal.aborted)
    never.resolve('late')
  })

  it('catch grace expires during a newly-started downstream call without restarting it', async () => {
    const below = deferred<string>()
    const expired = deferred<void>()
    let effects = 0
    let failures = 0
    let catchNext!: ModNext
    const result = dispatchModEvent({
      event: 'tool.call',
      input,
      catchGraceMs: 5,
      hooks: [
        hook(
          'catch-next',
          async (e, next, catching) => {
            if (!catching) throw new Error('failed')
            catchNext = next
            return `${await next(e)} transformed`
          },
          { hasCatch: true },
        ),
      ],
      core: async () => {
        effects++
        return below.promise
      },
      onFailure: () => {
        if (++failures === 2) expired.resolve()
      },
    })
    await expired.promise
    assert.ok(catchNext.signal.aborted)
    below.resolve('below')
    assert.equal(await result, 'below')
    assert.equal(effects, 1)
  })

  it('catch replay ignores changed input and invalid tier, but cannot revive ordinary next', async () => {
    let effects = 0
    let ordinary!: ModNext
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook(
          'replay',
          async (e, next, catching) => {
            if (!catching) {
              ordinary = next
              await next(e)
              throw new Error('failed')
            }
            await assert.rejects(ordinary(e))
            return next.to(undefined as unknown as ModInput, 'prepend')
          },
          { hasCatch: true },
        ),
      ],
      core: async () => ++effects,
    })
    assert.equal(result, 1)
    assert.equal(effects, 1)
  })

  it('parent abort interrupts recovery waiting for a pending downstream call', async () => {
    const parent = new AbortController()
    const failed = deferred<void>()
    const never = deferred<unknown>()
    let catches = 0
    const reason = new Error('abort recovery')
    const result = dispatchModEvent({
      event: 'tool.call',
      input,
      signal: parent.signal,
      hooks: [
        hook(
          'recovering',
          async (e, next, catching) => {
            if (catching) catches++
            void next(e)
            throw new Error('failed')
          },
          { hasCatch: true },
        ),
      ],
      core: async () => never.promise,
      onFailure: () => failed.resolve(),
    })
    await failed.promise
    parent.abort(reason)
    await assert.rejects(result, (error) => error === reason)
    assert.equal(catches, 0)
    never.resolve('late')
  })

  it('rejects missing next input and missing next.to target before starting work', async () => {
    let checked = false
    let effects = 0
    const result = await dispatchModEvent({
      event: 'tool.call',
      input,
      hooks: [
        hook('arguments', async (e, next) => {
          await assert.rejects(
            next(undefined as unknown as ModInput),
            /input object/,
          )
          await assert.rejects(
            next.to(e, undefined as unknown as ModTier),
            /tier/,
          )
          checked = true
          return next(e)
        }),
      ],
      core: async () => ++effects,
    })
    assert.ok(checked)
    assert.equal(result, 1)
    assert.equal(effects, 1)
  })

  it('parent abort ends an ignored catch without falling through to core', async () => {
    const parent = new AbortController()
    const started = deferred<void>()
    const never = deferred<unknown>()
    let effects = 0
    let catchNext!: ModNext
    const reason = new Error('abort catch')
    const result = dispatchModEvent({
      event: 'tool.call',
      input,
      signal: parent.signal,
      hooks: [
        hook(
          'catch',
          async (_e, next, catching) => {
            if (!catching) throw new Error('failed')
            catchNext = next
            started.resolve()
            return never.promise
          },
          { hasCatch: true },
        ),
      ],
      core: async () => ++effects,
    })
    await started.promise
    parent.abort(reason)
    await assert.rejects(result, (error) => error === reason)
    assert.ok(catchNext.signal.aborted)
    await assert.rejects(catchNext(input))
    assert.equal(effects, 0)
    never.resolve('late')
  })
})
