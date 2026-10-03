import { expect, test } from 'bun:test'

// Each scenario owns its module mocks and prefetch singleton in a fresh process.
// No security executable, user configuration, or real credentials are accessed.
const scenarios = [
  'throw-both',
  'callback-error',
  'not-found',
  'timeout',
  'success',
  'oauth-throw',
  'legacy-throw',
  'parallel',
] as const

for (const scenario of scenarios) {
  if (process.env.KEYCHAIN_PREFETCH_TEST_SCENARIO &&
      process.env.KEYCHAIN_PREFETCH_TEST_SCENARIO !== scenario) continue
  test(`keychain prefetch: ${scenario}`, async () => {
    const script = `
      const { mock } = await import('bun:test')
      const { default: assert } = await import('node:assert/strict')
      const scenario = ${JSON.stringify(scenario)}
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mock.module('../envUtils.js', () => ({
        isBareMode: () => false,
        getClaudeConfigHomeDir: () => '/unused-test-config',
      }))
      mock.module('src/constants/oauth.js', () => ({
        getOauthConfig: () => ({ OAUTH_FILE_SUFFIX: '' }),
      }))
      const calls = []
      const pending = []
      const unhandled = []
      process.on('unhandledRejection', error => unhandled.push(error))
      const execFile = (command, args, options, callback) => {
          assert.equal(command, 'security')
          assert.equal(options.timeout, 10000)
          assert.equal(options.encoding, 'utf-8')
          const index = calls.length
          calls.push(args)
          if (scenario === 'throw-both' ||
              (scenario === 'oauth-throw' && index === 0) ||
              (scenario === 'legacy-throw' && index === 1)) {
            throw Object.assign(new Error('posix_spawn security'), { code: 'EPERM' })
          }
          const finish = () => {
            if (scenario === 'callback-error') {
              callback(Object.assign(new Error('unavailable'), { code: 'EPERM' }), '')
            } else if (scenario === 'not-found') {
              callback(Object.assign(new Error('not found'), { code: 44 }), '')
            } else if (scenario === 'timeout') {
              callback(Object.assign(new Error('timeout'), { code: 44, killed: true }), '')
            } else {
              callback(null, index === 0 ? ' {"testCredential":"fixture"} \\n' : ' fixture-key \\n')
            }
          }
          if (scenario === 'parallel') pending.push(finish)
          else queueMicrotask(finish)
      }
      mock.module('child_process', () => ({ execFile }))
      assert.equal((await import('child_process')).execFile, execFile,
        'mock must be installed before importing prefetch')
      const helpers = await import('./macOsKeychainHelpers.ts')
      const prefetch = await import('./keychainPrefetch.ts')
      prefetch.startKeychainPrefetch()
      prefetch.startKeychainPrefetch()
      assert.equal(calls.length, 2, 'both reads start once')
      assert.ok(calls[0].at(-1).includes('-credentials'))
      assert.ok(!calls[1].at(-1).includes('-credentials'))
      // Delay the consumer as main.tsx does; detect early unhandled rejection.
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(unhandled.length, 0, 'startup must not reject before preAction')
      if (scenario === 'parallel') {
        assert.equal(pending.length, 2, 'neither read waits for the other')
        pending[1]()
        await Promise.resolve()
        assert.equal(prefetch.getLegacyApiKeyPrefetchResult(), null)
        pending[0]()
      }
      await prefetch.ensureKeychainPrefetchCompleted()
      const failedBoth = ['throw-both', 'callback-error', 'timeout'].includes(scenario)
      const oauthFailed = failedBoth || scenario === 'oauth-throw'
      const legacyFailed = failedBoth || scenario === 'legacy-throw'
      assert.equal(helpers.keychainCacheState.cache.cachedAt === 0, oauthFailed,
        'failed OAuth prefetch must leave synchronous reader cache invalid')
      assert.deepEqual(helpers.keychainCacheState.cache.data,
        oauthFailed || scenario === 'not-found' ? null : { testCredential: 'fixture' })
      assert.deepEqual(prefetch.getLegacyApiKeyPrefetchResult(),
        legacyFailed ? null : { stdout: scenario === 'not-found' ? null : 'fixture-key' },
        'failed legacy prefetch must leave synchronous fallback available')
      console.log('scenario passed')
    `
    if (process.env.KEYCHAIN_PREFETCH_TEST_SCENARIO) {
      await eval(`(async () => { ${script} })()`)
      return
    }
    const result = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      cwd: import.meta.dir,
      env: {
        PATH: process.env.PATH,
        HOME: import.meta.dir,
        USER: 'prefetch-test',
        KEYCHAIN_PREFETCH_TEST_SCENARIO: scenario,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    })
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }).toEqual({
      exitCode: 0,
      stdout: expect.stringContaining('scenario passed\n'),
      stderr: expect.stringContaining('1 pass'),
    })
  })
}
