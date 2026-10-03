import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Retained, repository-local fixtures only. The stub prevents real runtime/config IO.
const repository = resolve(import.meta.dir, '../../../..')
const runner = join(import.meta.dir, 'runner.ts')
const marker = '__CLAUDE_PLUGIN_TEST_RESULT__'
const fixture = await mkdtemp(join(repository, '.claude-test-evidence/runner-safety-'))
const stub = join(fixture, 'stub.ts')
await writeFile(stub, `
import { mock } from 'bun:test'
mock.module(${JSON.stringify(resolve(import.meta.dir, '../../../utils/plugins/pluginLoader.js'))}, () => ({
  createPluginFromPath: async () => ({ errors: [], plugin: {
    name: 'fixture', manifest: {}, hookModules: [{configPath: '/unused/hooks.json', paths: ['./hook.ts']}]
  } })
}))
mock.module(${JSON.stringify(resolve(import.meta.dir, '../runtime.js'))}, () => ({
  createModsRuntime: ({onDiagnostic}) => ({
    reconcile: async () => {}, bind: async () => {},
    registerHostCallback: () => () => {},
    dispatch: async (_event, input, core) => core(input),
    ui: { invalidate: async () => {}, invalidateInstance: async () => {}, mount: async (_input, host) => {
      host.render({type: 'Text'}, 1)
      return {dispose: async () => {throw new Error('mount teardown failed')}}
    } },
    dispose: async () => {
      if (globalThis.failDispose) throw new Error('runtime teardown failed')
      if (globalThis.lateDiagnostic) onDiagnostic({plugin: 'fixture', stage: 'dispose', message: 'late diagnostic'})
      if (globalThis.lateRejection) Promise.reject(new Error('teardown rejection'))
    },
  })
}))
`)

async function scenario(source: string, files: Record<string, string> = { 'one.test.ts': '' }) {
  const root = await mkdtemp(join(fixture, 'case-'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
  const script = join(root, 'harness.ts')
  await writeFile(script, `import {runPluginTests, runPluginTestFile} from ${JSON.stringify(runner)}\nconst root = ${JSON.stringify(root)}\n${source}`)
  const child = Bun.spawn([process.execPath, '--preload', stub, script], {
    cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: root },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(), 8000)
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(status, stderr).toBe(0)
    return JSON.parse(stdout.trim())
  } finally { clearTimeout(watchdog) }
}

const registered = `import {test} from 'claude-code/testing'; test('case', {timeoutMs: 1000}, async () => {})`

function passed(result: { tests: Array<{ failure?: string }> }): number {
  return result.tests.filter(test => test.failure === undefined).length
}

function failures(result: { file: string; tests: Array<{ name: string; failure?: string }>; loadFailure?: string }) {
  return [
    ...result.tests.flatMap(test => test.failure === undefined ? [] : [{ name: test.name, message: test.failure }]),
    ...(result.loadFailure === undefined ? [] : [{ name: result.file, message: result.loadFailure }]),
  ]
}

test('default command executes --child and isolates every file', async () => {
  const result = await scenario(`
    const spawn = Bun.spawn
    let launches = 0
    Bun.spawn = (command, options) => {
      launches++
      return spawn([command[0], '--preload', ${JSON.stringify(stub)}, ...command.slice(1)], options)
    }
    const result = await runPluginTests(root)
    console.log(JSON.stringify({result, launches}))
  `, {
    'one.test.ts': `import {test, expect} from 'claude-code/testing'; globalThis.shared = 1; test('first', () => {})`,
    'two.test.ts': `import {test, expect} from 'claude-code/testing'; test('isolated', () => expect(globalThis.shared).toBe(undefined))`,
  })
  expect(result.launches).toBe(2)
  expect(result.result.passed).toBe(2)
  expect(result.result.failed).toBe(0)
}, 15000)

test('discovery excludes dependencies and retained test environments on repeated runs', async () => {
  const result = await scenario(`
    const {mkdir, writeFile} = await import('node:fs/promises')
    for (const directory of ['node_modules/dependency', '.claude-test-environment/previous']) {
      await mkdir(root + '/' + directory, {recursive:true})
      await writeFile(root + '/' + directory + '/foreign.test.ts', '')
    }
    const runs = []
    for (let i = 0; i < 2; i++) {
      const result = await runPluginTests(root, {childCommand: file => [process.execPath, '-e',
        'console.log(${JSON.stringify(marker)} + JSON.stringify({file: ' + JSON.stringify(file) + ', tests: [{name: "case", durationMs: 1}]}))'
      ]})
      runs.push(result.files.map(item => item.file.slice(root.length + 1)))
    }
    console.log(JSON.stringify(runs))
  `)
  expect(result).toEqual([['one.test.ts'], ['one.test.ts']])
})

test('a success marker cannot override a nonzero child exit', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTests(root, {childCommand: file => [process.execPath, '-e',
      'console.log(${JSON.stringify(marker)} + JSON.stringify({file: ' + JSON.stringify(file) + ', tests: [{name: "case", durationMs: 1}]})); process.exitCode = 7'
    ]})))
  `)
  expect(result.passed).toBe(0)
  expect(result.failed).toBe(1)
  expect(result.files[0].loadFailure).toContain('7')
})

test.each([false, true])('parent bounds a stuck child even with a success marker: %s', async markerFirst => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTests(root, {fileTimeoutMs: 100, childCommand: file => {
      const report = ${markerFirst} ? 'console.log(' + JSON.stringify(${JSON.stringify(marker)} + JSON.stringify({file, tests:[{name:'case',durationMs:1}]})) + ');' : ''
      return [process.execPath, '-e', report + 'const end = Date.now() + 1000; while (Date.now() < end) {}']
    }})))
  `)
  expect(result.passed).toBe(0)
  expect(result.failed).toBe(1)
  expect(result.files[0].loadFailure).toContain('timed out after 100ms')
})

test('a timed out file does not prevent the next isolated file from running', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTests(root, {fileTimeoutMs: 200, childCommand: file => {
      const source = file.endsWith('one.test.ts')
        ? 'const end = Date.now() + 1000; while (Date.now() < end) {}'
        : 'console.log(' + JSON.stringify(${JSON.stringify(marker)} + JSON.stringify({file, tests:[{name:'case',durationMs:1}]})) + ')'
      return [process.execPath, '-e', source]
    }})))
  `, {'one.test.ts':'', 'two.test.ts':''})
  expect(result.passed).toBe(1)
  expect(result.failed).toBe(1)
  expect(result.files[0].loadFailure).toContain('timed out')
  expect(result.files[1].tests).toHaveLength(1)
  expect(result.files[1].loadFailure).toBeUndefined()
})

test('invalid file deadlines fail before spawning children', async () => {
  const result = await scenario(`
    let launches = 0
    Bun.spawn = () => { launches++; throw new Error('unexpected child') }
    const errors = []
    for (const fileTimeoutMs of [0, -1, NaN, Infinity]) {
      try { await runPluginTests(root, {fileTimeoutMs}) } catch (error) { errors.push(error.message) }
    }
    console.log(JSON.stringify({launches, errors}))
  `)
  expect(result.launches).toBe(0)
  expect(result.errors).toEqual(Array(4).fill('fileTimeoutMs must be a positive finite number'))
})

test('child environment is explicit and does not inherit arbitrary credentials or preload options', async () => {
  const result = await scenario(`
    const spawn = Bun.spawn
    let keys, isolatedHome
    Bun.spawn = (command, options) => {
      isolatedHome = options.env?.HOME?.startsWith(root + '/.claude-test-environment/home-')
      keys = options.env ? Object.keys(options.env) : null
      return spawn(command, options)
    }
    await runPluginTests(root, {childCommand: file => [process.execPath, '-e',
      'console.log(${JSON.stringify(marker)} + JSON.stringify({file: ' + JSON.stringify(file) + ', tests: []}))'
    ]})
    console.log(JSON.stringify({keys, isolatedHome}))
  `)
  expect(result.isolatedHome).toBe(true)
  expect(result.keys).not.toBeNull()
  expect(result.keys.every((key: string) => ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'LANG', 'TZ'].includes(key))).toBe(true)
})

test('success cancels the deadline and uses no fixed 25ms grace timer', async () => {
  const result = await scenario(`
    const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout
    const active = new Set(), delays = []
    globalThis.setTimeout = (fn, delay, ...args) => {
      delays.push(delay)
      let handle = nativeSet(() => {active.delete(handle); fn(...args)}, delay)
      active.add(handle); return handle
    }
    globalThis.clearTimeout = handle => {active.delete(handle); nativeClear(handle)}
    const result = await runPluginTestFile(root, root + '/one.test.ts')
    console.log(JSON.stringify({result, active: active.size, delays}))
  `, { 'one.test.ts': registered })
  expect(passed(result.result)).toBe(1)
  expect(result.active).toBe(0)
  expect(result.delays).not.toContain(25)
})

test('runtime teardown failure prevents passed accounting', async () => {
  const result = await scenario(`
    globalThis.failDispose = true
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': registered })
  expect(passed(result)).toBe(0)
  expect(failures(result).some((failure: any) => failure.message.includes('runtime teardown failed'))).toBe(true)
})

test('UI teardown errors are reported rather than swallowed', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': `import {test} from 'claude-code/testing'; test('mount', async $ => {await $.ui.mount('fixture')})` })
  expect(passed(result)).toBe(0)
  expect(failures(result).some((failure: any) => failure.message.includes('mount teardown failed'))).toBe(true)
})

test('loading failures release timers and become file failures', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': `setInterval(() => {}, 10000); throw new Error('load failed')` })
  expect(passed(result)).toBe(0)
  expect(result.loadFailure).toContain('load failed')
})

test('teardown diagnostics and rejection notifications fail before listeners are removed', async () => {
  const result = await scenario(`
    globalThis.lateDiagnostic = true
    globalThis.lateRejection = true
    const before = ['unhandledRejection', 'uncaughtException'].map(name => process.listenerCount(name))
    const result = await runPluginTestFile(root, root + '/one.test.ts')
    const after = ['unhandledRejection', 'uncaughtException'].map(name => process.listenerCount(name))
    console.log(JSON.stringify({result, before, after}))
  `, { 'one.test.ts': registered })
  expect(passed(result.result)).toBe(0)
  expect(failures(result.result).some((entry: any) => entry.message.includes('late diagnostic'))).toBe(true)
  expect(failures(result.result).some((entry: any) => entry.message.includes('teardown rejection'))).toBe(true)
  expect(result.after).toEqual(result.before)
})

test('parent waits for delayed child exit after the result marker', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTests(root, {childCommand: file => [process.execPath, '-e',
      'console.log(${JSON.stringify(marker)} + JSON.stringify({file: ' + JSON.stringify(file) + ', tests: [{name: "case", durationMs: 1}]})); setTimeout(() => {process.exitCode = 9}, 60)'
    ]})))
  `)
  expect(result.passed).toBe(0)
  expect(result.files[0].loadFailure).toContain('9')
})

test('timed out bodies fail and release tracked timers', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': `import {test} from 'claude-code/testing'; test('timeout', {timeoutMs: 10}, () => new Promise(() => {setInterval(() => {}, 10000)}))` })
  expect(passed(result)).toBe(0)
  expect(failures(result)[0].message).toContain('timed out')
})

test('records every case name and observed duration', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': `import {describe, test} from 'claude-code/testing';
    describe('suite', () => {
      test('measured', () => {const start = performance.now(); while (performance.now() - start < 8) {}});
      test('quick', () => {});
    });` })
  expect(result.tests.map((entry: any) => entry.name)).toEqual(['suite > measured', 'suite > quick'])
  expect(result.tests[0].durationMs).toBeGreaterThanOrEqual(8)
  expect(result.tests[1].durationMs).toBeGreaterThanOrEqual(0)
  expect(result.tests.every((entry: any) => Number.isFinite(entry.durationMs))).toBe(true)
})

test('aggregates teardown diagnostics into one failed case', async () => {
  const result = await scenario(`
    globalThis.lateDiagnostic = true
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': registered })
  expect(result.tests).toHaveLength(1)
  expect(result.tests[0].name).toBe('case')
  expect(result.tests[0].failure).toContain('late diagnostic')
  expect(result.tests.filter((entry: any) => entry.failure !== undefined)).toHaveLength(1)
})

test('reports file loading errors separately from test cases', async () => {
  const result = await scenario(`
    console.log(JSON.stringify(await runPluginTestFile(root, root + '/one.test.ts')))
  `, { 'one.test.ts': `throw new Error('load failed before registration')` })
  expect(result.tests).toEqual([])
  expect(result.loadFailure).toContain('load failed before registration')
})
