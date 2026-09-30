import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { COMMIT, OFFICIAL, assessBuiltinAcceptance, check, cleanRun, createRun, fetchOfficial, findOfficial, fixtureEnvironment, inventory, isIdlePrompt, parseArgs, prepareFixture, sandboxProfile, startBuiltinRun } from './mods-test-lab.mjs'

const roots = []
function temp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mods-lab-test-')))
  roots.push(root)
  return root
}
function shortTemp() {
  const root = realpathSync(mkdtempSync('/private/tmp/mlt-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function upstream() {
  const files = Object.fromEntries(OFFICIAL.flatMap(name => [
    [`mods/${name}/.claude-plugin/plugin.json`, JSON.stringify({ name, version: '0.1.0' })],
    [`mods/${name}/hooks/hooks.json`, JSON.stringify({ modules: ['./register.ts'] })],
    [`mods/${name}/hooks/register.ts`, 'throw new Error("DO_NOT_EXECUTE_UPSTREAM"); export function register() {}'],
    [`mods/${name}/nested/notes.txt`, `${name} preserved`],
  ]))
  // Synthetic transport bytes, never used for author-contract/type validation.
  files['mods/types/claude-code.d.ts'] = 'declare module "claude-code" {}'
  files['mods/types/extra.d.ts'] = '// All type subtree files must survive'
  files['not-selected/secret.txt'] = 'not retained'
  // GitHub's tree response identifies the tree object, not the requested commit.
  const tree = { sha: 'a'.repeat(40), truncated: false, tree: Object.entries(files).map(([path, value]) => {
    const bytes = Buffer.from(value)
    return { path, type: 'blob', mode: '100644', size: bytes.length, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }
  }) }
  const archive = () => zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [`claude-code-${COMMIT}/${path}`, Buffer.from(value)])))
  const urls = []
  const download = (url, destination) => {
    urls.push(url)
    writeFileSync(destination, url.includes('/git/trees/') ? JSON.stringify(tree) : archive())
  }
  return { files, tree, archive, download, urls }
}

function plugin(root, source = 'export function register(on) {}') {
  const path = join(root, 'fixture-plugin')
  mkdirSync(join(path, '.claude-plugin'), { recursive: true })
  mkdirSync(join(path, 'hooks'))
  writeFileSync(join(path, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'launcher-fixture', version: '0.1.0' }))
  writeFileSync(join(path, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  writeFileSync(join(path, 'hooks/register.ts'), source)
  return path
}

describe('argument boundaries', () => {
  test('accepts only the four commands and fixed targets, with explicit overrides', () => {
    expect(COMMIT).toBe('7974a70773fa229e4cc65aa1b356cc21f5c216c4')
    expect(parseArgs(['fetch-official']).command).toBe('fetch-official')
    for (const name of ['sample', ...OFFICIAL]) expect(parseArgs(['check', name]).target).toBe(name)
    const args = parseArgs(['run', 'sample', '--binary', '/tmp/custom-binary', '--cache', '/tmp/lab', '--api-url', 'http://127.0.0.1:65432'])
    expect(args.binary).toBe('/tmp/custom-binary')
    expect(args.apiUrl).toBe('http://127.0.0.1:65432')
    expect(parseArgs(['run-builtin', '--binary', '/tmp/custom-binary']).target).toBeUndefined()
    expect(parseArgs(['clean', 'r-123456abcdef']).target).toBe('r-123456abcdef')
  })
  test('rejects arbitrary flags, targets, endpoints, duplicates and absent values', () => {
    for (const args of [[], ['fetch-official', 'diff'], ['run-builtin', 'diff'], ['check'], ['check', 'unknown'], ['run', 'sample', '--bare'], ['check', 'diff', '--binary', '/tmp/x'], ['run', 'sample', '--binary'], ['run', 'sample', '--cache', '/tmp/a', '--cache', '/tmp/b']]) expect(() => parseArgs(args)).toThrow()
    for (const endpoint of ['https://api.anthropic.com', 'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://user@127.0.0.1:1234', 'http://127.0.0.1:1234?x=1', 'http://127.0.0.2:1234']) expect(() => parseArgs(['run', 'sample', '--api-url', endpoint])).toThrow()
  })
})

describe('offline fixed-commit cache', () => {
  test('publishes all four complete subtrees plus full types, without upstream execution', () => {
    const cache = temp()
    const remote = upstream()
    const record = fetchOfficial(cache, remote.download)
    expect(record.commit).toBe(COMMIT)
    expect(record.reused).toBe(false)
    expect(remote.urls).toHaveLength(2)
    expect(record.files).toHaveLength(18)
    expect(existsSync(join(record.path, 'not-selected'))).toBe(false)
    expect(readFileSync(join(record.path, 'mods/types/extra.d.ts'), 'utf8')).toContain('All type subtree')
    expect(Object.keys(record.manifests)).toEqual(OFFICIAL)
    expect(findOfficial(cache)).toBe(record.path)
    const reused = fetchOfficial(cache, () => { throw new Error('network must not be used') })
    expect(reused.reused).toBe(true)
    expect(reused.sha256).toBe(record.sha256)
  })
  test('recovers invalid cache and interrupted stage by publication, preserving old evidence', () => {
    const cache = temp()
    const remote = upstream()
    const old = fetchOfficial(cache, remote.download)
    const changed = join(old.path, 'mods/diff/nested/notes.txt')
    writeFileSync(changed, 'user evidence')
    const interrupted = join(cache, 'official', COMMIT, '.stage-interrupted')
    mkdirSync(interrupted)
    writeFileSync(join(interrupted, 'evidence.txt'), 'keep')
    expect(findOfficial(cache)).toBeUndefined()
    const fresh = fetchOfficial(cache, remote.download)
    expect(fresh.path).not.toBe(old.path)
    expect(readFileSync(changed, 'utf8')).toBe('user evidence')
    expect(readFileSync(join(interrupted, 'evidence.txt'), 'utf8')).toBe('keep')
    expect(fresh.sha256).toBe(old.sha256)
    expect(fetchOfficial(cache, () => { throw new Error('unnecessary network') }).path).toBe(fresh.path)
  })
  test('does not publish failed downloads and can resume with a fresh stage', () => {
    const cache = temp()
    const remote = upstream()
    expect(() => fetchOfficial(cache, (url, destination) => {
      if (url.includes('codeload')) throw new Error('interrupted download')
      remote.download(url, destination)
    })).toThrow('interrupted')
    expect(findOfficial(cache)).toBeUndefined()
    expect(fetchOfficial(cache, remote.download).reused).toBe(false)
  })
  test('rejects incomplete trees, links, traversal, changed archive bytes and missing types', () => {
    for (const mutate of [
      remote => { remote.tree.truncated = true },
      remote => { remote.tree.tree[0].mode = '120000' },
      remote => { remote.tree.tree[0].path = 'mods/diff/../../escape' },
      remote => { remote.files['mods/diff/nested/notes.txt'] = 'tampered' },
      remote => { remote.tree.tree = remote.tree.tree.filter(file => !file.path.startsWith('mods/types/')); delete remote.files['mods/types/claude-code.d.ts'] },
      remote => { remote.files['mods/diff/../escape'] = 'escape' },
    ]) {
      const cache = temp()
      const remote = upstream()
      mutate(remote)
      expect(() => fetchOfficial(cache, remote.download)).toThrow()
      expect(findOfficial(cache)).toBeUndefined()
      expect(existsSync(join(cache, 'escape'))).toBe(false)
    }
  })
  test('content identity is independent of absolute location and detects extra files/links', () => {
    const one = fetchOfficial(temp(), upstream().download)
    const two = fetchOfficial(temp(), upstream().download)
    expect(one.sha256).toBe(two.sha256)
    writeFileSync(join(one.path, 'mods/types/extra.txt'), 'unexpected')
    expect(findOfficial(join(one.path, '../../..'))).toBeUndefined()
    symlinkSync('/etc/passwd', join(two.path, 'mods/types/link'))
    expect(() => inventory(join(two.path, 'mods'))).toThrow('link')
  })
})

describe('private fixtures without a compiled TTY', () => {
  test('initializes real empty-template git fixture and an empty keychain executable', () => {
    const root = temp()
    const run = createRun(root, 'check')
    const env = prepareFixture(run, plugin(root))
    expect(existsSync(join(run, 'project/.git/info'))).toBe(true)
    const diff = execFileSync('/usr/bin/git', ['diff', '--', 'tracked.txt'], { cwd: join(run, 'project'), env, encoding: 'utf8' })
    expect(diff).toContain('-before')
    expect(diff).toContain('+after')
    expect(() => execFileSync(join(run, 'bin/security'), ['find-generic-password'], { env, stdio: 'pipe' })).toThrow()
    try { execFileSync(join(run, 'bin/security'), [], { env, stdio: 'pipe' }) } catch (error) { expect(error.status).toBe(44) }
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1')
    expect(env.ENABLE_TOOL_SEARCH).toBe('true')
    expect(env.ANTHROPIC_API_KEY).toContain('fake')
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.HOME).toBe(join(run, 'home'))
    expect(fixtureEnvironment(run)).toEqual(env)
    const profile = sandboxProfile(run)
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/security"))')
    expect(profile).toContain('(deny file-read-data (require-all')
    expect(profile).not.toContain('(deny file-read* (require-all')
    expect(profile).toContain('/Library/Keychains')
    expect(profile).toContain('com.apple.securityd')
  })
  test('runs actual discovery/prepare/loader in an isolated non-TTY subprocess', () => {
    const root = temp()
    const run = createRun(root, 'check')
    const env = prepareFixture(run, plugin(root, 'export function register(on) { throw new Error("CHECK_MUST_NOT_ACTIVATE") }'))
    const profile = join(run, 'check.sb')
    writeFileSync(profile, sandboxProfile(run, true))
    const script = import.meta.path.replace('.test.mjs', '.mjs')
    const expression = `const {spawnSync} = await import('node:child_process');
      const emptyKeychain = spawnSync('security', []);
      if (emptyKeychain.status !== 44) throw new Error('Empty keychain stub did not run');
      const actualSecurity = spawnSync('/usr/bin/security', ['--help']);
      if (!actualSecurity.error || actualSecurity.error.code !== 'EPERM') throw new Error('Real security executable was not denied');
      const {inspectPlugin} = await import(${JSON.stringify(script)}); console.log(JSON.stringify(await inspectPlugin(${JSON.stringify(join(run, 'plugin'))})))`
    const child = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '--eval', expression], { cwd: join(run, 'project'), env, encoding: 'utf8', timeout: 60000 })
    if (child.status !== 0) throw new Error(`${child.error ?? ''}\n${child.stderr}\n${child.stdout}`)
    const report = JSON.parse(child.stdout)
    if (report.errors.length) throw new Error(JSON.stringify(report, null, 2))
    expect(report.discovery).toBe('passed')
    expect(report.preparation).toBe('passed')
    expect(report.scan).toBe('passed')
    expect(report.errors).toEqual([])
    expect(report.declarations[0].tier).toBe('user')
    expect(report.admission).toStartWith('not-run')
    expect(report.activation).toBe('not-run')
    expect(report.trigger).toBe('not-run')
  }, 60000)
  test('check requires a downloaded official cache and never implicitly downloads', () => {
    expect(() => check(parseArgs(['check', 'diff', '--cache', temp()]))).toThrow('fetch-official first')
  })
})

describe('builtin-only compiled launcher', () => {
  test('builds a private sandboxed tmux launch without inline plugin or archive override', () => {
    const cache = shortTemp()
    const binary = join(shortTemp(), 'built-claude')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const calls = []
    const before = process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE
    process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE = '/tmp/caller-override.zip'
    let report
    try {
      report = startBuiltinRun(parseArgs(['run-builtin', '--binary', binary, '--cache', cache]), (file, args, options) => {
        calls.push({ file, args, options })
        return 'mods:0.0 %1 12345\n'
      }, () => '/usr/local/bin/tmux')
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE
      else process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE = before
    }

    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/usr/local/bin/tmux')
    expect(calls[0].args).toContain('new-session')
    expect(calls[0].options.cwd).toBeUndefined()
    expect(report.argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(report.argv).not.toContain('--plugin-dir')
    expect(report.argv).toContain('--dangerously-skip-permissions')
    expect(report.mode).toBe('builtin-only')
    expect(report.source).toBeUndefined()
    expect(report.plugin).toBeUndefined()
    expect(report.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE).toBeUndefined()
    expect(calls[0].options.env).toEqual(report.env)
    for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP']) expect(report.env[key]).toStartWith(`${report.run}/`)
    expect(existsSync(join(report.run, 'plugin'))).toBe(false)
    expect(readFileSync(join(report.run, 'run.json'), 'utf8')).toContain('builtin-only')
  })


  test('applies acceptance settings before the copied binary starts', () => {
    const cache = shortTemp()
    const binary = join(shortTemp(), 'built-claude')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    let configured
    const report = startBuiltinRun(parseArgs(['run-builtin', '--binary', binary, '--cache', cache]), (_file, _args, { env }) => {
      const settings = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'))
      expect(settings.pluginConfigs['agents-md@builtin'].options.instructionFiles).toBe('managed-only')
      expect(settings.enabledPlugins['diff@builtin']).toBe(false)
      expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-5-20250929')
      return 'mods:0.0 %1 12345\n'
    }, () => '/usr/local/bin/tmux', (run, env) => {
      configured = run
      env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
      writeFileSync(join(run, 'config/settings.json'), JSON.stringify({ enabledPlugins: { 'diff@builtin': false }, pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'managed-only' } } } }))
    })
    expect(report.run).toBe(configured)
    expect(report.argv).not.toContain('--plugin-dir')
    expect(report.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE).toBeUndefined()
  })

  test('adds only the explicit release acceptance fixture when requested', () => {
    const cache = shortTemp()
    const binary = join(shortTemp(), 'built-claude')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const fixture = plugin(shortTemp())
    const report = startBuiltinRun(
      parseArgs(['run-builtin', '--binary', binary, '--cache', cache]),
      () => 'mods:0.0 %1 12345\n',
      () => '/usr/local/bin/tmux',
      undefined,
      fixture,
    )
    expect(report.mode).toBe('builtin-with-inline-acceptance-fixture')
    expect(report.argv).toContain('--plugin-dir')
    expect(report.argv).toContain(join(report.run, 'plugin'))
    expect(report.argv).not.toContain(fixture)
    expect(report.argv).not.toContain('--plugin-dir=' + fixture)
    expect(report.plugin.sha256).toBe(inventory(fixture).sha256)
    expect(report.note).toContain('copied inline acceptance fixture')
    expect(report.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE).toBeUndefined()
  })

  test('fails clearly before tmux when the selected binary is missing', () => {
    const cache = temp()
    let called = false
    expect(() => startBuiltinRun(parseArgs(['run-builtin', '--binary', join(cache, 'missing'), '--cache', cache]), () => { called = true }, () => '/usr/local/bin/tmux')).toThrow('Built Claude binary not found')
    expect(called).toBe(false)
  })
})

describe('deterministic compiled builtin acceptance', () => {
  test('waits for an idle prompt after the completion marker before sending a local command', () => {
    expect(isIdlePrompt('⏺ MODS_TOOLSEARCH_COMPLETE:acceptance123\n✽ Tomfoolering…\n❯ ')).toBe(false)
    expect(isIdlePrompt('⏺ MODS_TOOLSEARCH_COMPLETE:acceptance123\n❯ \n⏵⏵ bypass permissions on')).toBe(true)
  })

  test('acceptance CLI owns its mock endpoint and accepts no target', () => {
    expect(parseArgs(['accept-builtin', '--cache', '/private/tmp/mlab']).command).toBe('accept-builtin')
    expect(() => parseArgs(['accept-builtin', 'diff'])).toThrow()
    expect(() => parseArgs(['accept-builtin', '--api-url', 'http://127.0.0.1:1234'])).toThrow()
  })

  test('managed-only differential requires a real main request on both sides', async () => {
    const { assessBuiltinAcceptance } = await import('./mods-test-lab.mjs')
    const request = text => ({ body: { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: `MODS_ACCEPT_PROMPT ${text}` }] } })
    const binarySha256 = 'a'.repeat(64)
    const cleanup = { verdict: 'passed', paneDead: true, tmuxKill: { status: 0 }, providerClose: { status: 0 }, status: 0 }
    const pair = {
      enabled: { binarySha256, cleanup, requests: [request('')], catalog: 'View uncommitted changes and per-turn diffs', diff: 'tracked.txt\n-before\n+after', closed: '❯\n bypass permissions on', dismissalEscapes: 2 },
      disabled: { binarySha256, cleanup, requests: [request('MODS_ACCEPT_CLAUDE_MARKER MODS_TEST_LAB_AGENTS_MARKER')], catalog: 'View uncommitted changes and per-turn diffs', diff: 'tracked.txt\n-before\n+after', closed: '❯\n bypass permissions on', dismissalEscapes: 2 },
      securityOrdinary: { binarySha256, cleanup, registration: 'registration=mcp__mods-test-lab__acceptance-probe', toolSearch: 'MODS_TOOLSEARCH_COMPLETE:acceptance123', requests: [
        { body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'Generate a title' }] } },
        request('MODS_TOOLSEARCH_PROMPT:acceptance123'),
        { body: { model: 'claude-sonnet-4-5-20250929', messages: [
          { role: 'user', content: 'MODS_TOOLSEARCH_PROMPT:acceptance123' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mods_ts_acceptance123', content: 'found' }] },
        ] } },
        { body: { model: 'claude-sonnet-4-5-20250929', messages: [
          { role: 'user', content: 'MODS_TOOLSEARCH_PROMPT:acceptance123' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mods_ts_acceptance123', content: 'found' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mods_dynamic_acceptance123', content: 'MODS_DYNAMIC_RESULT:acceptance123' }] },
        ] } },
      ], suggestionBase: 'MODS_SUGGESTION:base:basecheck\nsuggestion=shown:base:basecheck', suggestionReplacement: 'MODS_SUGGESTION:replacement:replacementcheck\nsuggestion=shown:replacement:replacementcheck', suggestionRollback: 'MODS_SUGGESTION:replacement:rollbackcheck\nsuggestion=shown:replacement:rollbackcheck', opened: 'Mods test lab\nLocal input', interacted: 'Input length=2/256\nControls: {"button":0,"input":1,"submit":1,"select":0}', resized: 'Mods test lab\nInput length=2/256\nControls: {"button":0,"input":1,"submit":1,"select":0}', closed: 'bypass permissions on', reopened: 'Mods test lab\nInput length=2/256\nEvents: background', reclosed: 'bypass permissions on' },
      securityTeam: { binarySha256, cleanup, registration: 'denied: Managed allowedMcpServers policy does not permit user plugin tool registration' },
      securityEnterprise: { binarySha256, cleanup, registration: 'denied: Managed allowedMcpServers policy does not permit user plugin tool registration' },
      privacyOff: { binarySha256, cleanup, ledger: [] },
      privacyOn: { binarySha256, cleanup, ledger: [
        { sequence: 1, operation: 'authorize', credentialKind: 'bearer', granted: true },
        { sequence: 2, operation: 'authorize', credentialKind: 'bearer', granted: true },
        { sequence: 3, operation: 'http', method: 'POST', host: 'api.anthropic.com', path: '/api/event_logging/v2/batch', authorized: true },
      ] },
    }
    const result = assessBuiltinAcceptance(pair)
    expect(result.completeness.verdict).toBe('passed')
    expect(result.cleanup.verdict).toBe('passed')
    expect(result.agents.verdict).toBe('passed')
    expect(result.security.verdict).toBe('passed')
    expect(result.ui.verdict).toBe('passed')
    expect(result.dynamicTools.verdict).toBe('passed')
    expect(result.suggestionReload.verdict).toBe('passed')
    const auxiliary = { body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'MODS_ACCEPT_PROMPT MODS_ACCEPT_CLAUDE_MARKER' }] } }
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, requests: [auxiliary] } }).agents.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, requests: [...pair.enabled.requests, auxiliary] } }).agents.verdict).toBe('passed')
    expect(result.diff.verdict).toBe('passed')
    expect(result.telemetry.verdict).toBe('passed')
    expect(assessBuiltinAcceptance({ ...pair, privacyOff: { ledger: pair.privacyOn.ledger } }).telemetry.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, privacyOn: { ledger: pair.privacyOn.ledger.slice(1) } }).telemetry.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, error: 'Timed out during exit' } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, disabled: { ...pair.disabled, cleanup: { status: 1 } } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, disabled: { ...pair.disabled, cleanup: { ...cleanup, providerClose: { status: 1 }, verdict: 'failed' } } }).cleanup.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, privacyOff: { ledger: [] } }).completeness.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, disabled: undefined }).completeness.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, privacyOn: { ...pair.privacyOn, binarySha256: 'b'.repeat(64) } }).completeness.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, requests: [] } }).agents.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, requests: [request('MODS_ACCEPT_CLAUDE_MARKER')] } }).agents.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, disabled: { ...pair.disabled, requests: [request('')] } }).agents.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, catalog: 'Toggle the diff panel showing uncommitted changes' } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, diff: 'Diff panel shown' } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, closed: 'bypass permissions on tracked.txt Enter to view' } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, disabled: { ...pair.disabled, diff: 'tracked.txt +after' } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, enabled: { ...pair.enabled, dismissalEscapes: 1 } }).diff.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityTeam: { ...pair.securityTeam, registration: 'registered' } }).security.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, registration: 'denied' } }).security.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, interacted: 'Mods test lab' } }).ui.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, resized: 'Mods test lab' } }).ui.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, reopened: 'Mods test lab\nInput length=2/256' } }).ui.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, toolSearch: '' } }).dynamicTools.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, requests: pair.securityOrdinary.requests.slice(0, 3) } }).dynamicTools.verdict).toBe('failed')
    expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, requests: [...pair.securityOrdinary.requests, pair.securityOrdinary.requests[3]] } }).dynamicTools.verdict).toBe('failed')
    for (const mutation of [
      { suggestionBase: '' },
      { suggestionReplacement: 'MODS_SUGGESTION:base:replacementcheck\nsuggestion=shown:base:replacementcheck' },
      { suggestionReplacement: `${pair.securityOrdinary.suggestionReplacement}\n${pair.securityOrdinary.suggestionReplacement}` },
      { suggestionRollback: 'MODS_SUGGESTION:base:rollbackcheck\nsuggestion=shown:base:rollbackcheck' },
    ]) expect(assessBuiltinAcceptance({ ...pair, securityOrdinary: { ...pair.securityOrdinary, ...mutation } }).suggestionReload.verdict).toBe('failed')
  })

  test('places configured acceptance evidence inside the sandbox-writable child run', () => {
    const cache = shortTemp()
    const binary = join(shortTemp(), 'built-claude')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const report = startBuiltinRun(parseArgs(['run-builtin', '--binary', binary, '--cache', cache]),
      () => 'mods:0.0 %1 12345\n', () => '/usr/local/bin/tmux', (run, env) => {
        const ledger = join(run, 'host.jsonl')
        writeFileSync(ledger, '', { mode: 0o600 })
        env.CLAUDE_CODE_MODS_ACCEPTANCE_LEDGER = ledger
      })
    expect(report.env.CLAUDE_CODE_MODS_ACCEPTANCE_LEDGER).toStartWith(`${report.run}/`)
    expect(readFileSync(report.env.CLAUDE_CODE_MODS_ACCEPTANCE_LEDGER, 'utf8')).toBe('')
  })

  test('loopback provider records bodies, never headers, and emits deterministic SSE', async () => {
    const { startAcceptanceProvider } = await import('./mods-test-lab.mjs')
    const root = temp()
    const provider = await startAcceptanceProvider(root)
    const post = body => globalThis.fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'secret-header-must-not-be-recorded' },
      body: JSON.stringify({ stream: true, model: 'claude-sonnet-4-5-20250929', ...body }),
    }).then(response => response.text())
    try {
      expect(provider.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const text = await post({ messages: [{ role: 'user', content: 'MODS_ACCEPT_PROMPT' }] })
      expect(text).toContain('event: message_start')
      expect(text).toContain('MODS_ACCEPT_RESPONSE')
      expect(text).toContain('event: message_stop')

      const nonce = 'probe123'
      const toolSearch = await post({ messages: [{ role: 'user', content: `MODS_TOOLSEARCH_PROMPT:${nonce}` }] })
      expect(toolSearch).toContain('"name":"ToolSearch"')
      expect(toolSearch).toContain(`select:mcp__mods-test-lab__dynamic_${nonce}`)
      expect(toolSearch).toContain('"stop_reason":"tool_use"')

      const dynamic = await post({ messages: [
        { role: 'user', content: `MODS_TOOLSEARCH_PROMPT:${nonce}` },
        { role: 'assistant', content: [{ type: 'tool_use', id: `mods_ts_${nonce}`, name: 'ToolSearch', input: { query: `select:mcp__mods-test-lab__dynamic_${nonce}` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `mods_ts_${nonce}`, content: 'found' }] },
      ] })
      expect(dynamic).toContain(`"name":"mcp__mods-test-lab__dynamic_${nonce}"`)
      expect(dynamic).toContain(`partial_json":"{\\"value\\":\\"${nonce}\\"}"`)

      const complete = await post({ messages: [
        { role: 'user', content: `MODS_TOOLSEARCH_PROMPT:${nonce}` },
        { role: 'assistant', content: [{ type: 'tool_use', id: `mods_dynamic_${nonce}`, name: `mcp__mods-test-lab__dynamic_${nonce}`, input: { value: nonce } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `mods_dynamic_${nonce}`, content: `MODS_DYNAMIC_RESULT:${nonce}` }] },
      ] })
      expect(complete).toContain(`MODS_TOOLSEARCH_COMPLETE:${nonce}`)
      expect(provider.requests).toHaveLength(4)
      expect(readFileSync(join(root, 'requests.jsonl'), 'utf8')).not.toContain('secret-header-must-not-be-recorded')
      expect((await globalThis.fetch(`${provider.url}/unexpected`)).status).toBe(404)
    } finally { await provider.close() }
  })
})

describe('clean only stopped owned runs', () => {
  test('deletes a stopped run but not adjacent cache or user directories', () => {
    const cache = temp()
    const run = createRun(cache, 'check')
    const evidence = join(cache, 'user-evidence')
    mkdirSync(evidence)
    writeFileSync(join(evidence, 'keep'), 'keep')
    expect(cleanRun(cache, run)).toEqual({ cleaned: run })
    expect(existsSync(run)).toBe(false)
    expect(readFileSync(join(evidence, 'keep'), 'utf8')).toBe('keep')
  })
  test('rejects non-owned, sealed, traversal and symlink targets', () => {
    const cache = temp()
    const run = createRun(cache, 'check')
    writeFileSync(join(run, 'SEALED'), '')
    expect(() => cleanRun(cache, run)).toThrow('Sealed')
    expect(() => cleanRun(cache, '../')).toThrow()
    expect(() => cleanRun(cache, cache)).toThrow()
    const foreign = join(cache, 'runs/r-123456abcdef')
    mkdirSync(foreign)
    writeFileSync(join(foreign, '.mods-test-lab.json'), '{}')
    expect(() => cleanRun(cache, foreign)).toThrow('Not an owned')
    const linked = join(cache, 'runs/r-abcdef123456')
    symlinkSync(run, linked)
    expect(() => cleanRun(cache, linked)).toThrow('Not an owned')
    expect(existsSync(run)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
  })
  test('rejects live launchers and socket links before invoking tmux', () => {
    const cache = temp()
    const run = createRun(cache, 'run')
    const markerPath = join(run, '.mods-test-lab.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    writeFileSync(markerPath, JSON.stringify({ ...marker, launcherPid: process.ppid }))
    expect(() => cleanRun(cache, run)).toThrow('still active')
    writeFileSync(markerPath, JSON.stringify(marker))
    symlinkSync(join(run, '.mods-test-lab.json'), join(run, 'tmux.sock'))
    expect(() => cleanRun(cache, run, () => { throw new Error('must not call tmux') })).toThrow('owned tmux socket')
  })
  test('refuses active/unknown sessions, stops only dead owned panes', async () => {
    const cache = temp()
    const run = createRun(cache, 'run')
    const server = createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(run, 'tmux.sock'), resolve) })
    try {
      for (const result of [{ status: 0, stdout: '0\n' }, { status: 0, stdout: '1\n0\n' }, { status: 0, stdout: '' }, { status: 1, stderr: 'permission denied' }]) {
        expect(() => cleanRun(cache, run, () => result)).toThrow()
        expect(existsSync(run)).toBe(true)
      }
      const calls = []
      cleanRun(cache, run, (_file, args) => { calls.push(args); return { status: 0, stdout: '1\n' } })
      expect(calls.map(args => args[2])).toEqual(['list-panes', 'kill-server'])
      expect(calls.every(args => args[1] === join(run, 'tmux.sock'))).toBe(true)
      expect(existsSync(run)).toBe(false)
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
})
