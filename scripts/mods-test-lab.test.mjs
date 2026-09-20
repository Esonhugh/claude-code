import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { COMMIT, OFFICIAL, check, cleanRun, createRun, fetchOfficial, findOfficial, fixtureEnvironment, inventory, parseArgs, prepareFixture, sandboxProfile } from './mods-test-lab.mjs'

const roots = []
function temp() {
  const root = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'mods-lab-test-')))
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
    expect(parseArgs(['fetch-official']).command).toBe('fetch-official')
    for (const name of ['sample', ...OFFICIAL]) expect(parseArgs(['check', name]).target).toBe(name)
    const args = parseArgs(['run', 'sample', '--binary', '/tmp/custom-binary', '--cache', '/tmp/lab', '--api-url', 'http://127.0.0.1:65432'])
    expect(args.binary).toBe('/tmp/custom-binary')
    expect(args.apiUrl).toBe('http://127.0.0.1:65432')
    expect(parseArgs(['clean', 'r-123456abcdef']).target).toBe('r-123456abcdef')
  })
  test('rejects arbitrary flags, targets, endpoints, duplicates and absent values', () => {
    for (const args of [[], ['fetch-official', 'diff'], ['check'], ['check', 'unknown'], ['run', 'sample', '--bare'], ['check', 'diff', '--binary', '/tmp/x'], ['run', 'sample', '--binary'], ['run', 'sample', '--cache', '/tmp/a', '--cache', '/tmp/b']]) expect(() => parseArgs(args)).toThrow()
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
    expect(env.ANTHROPIC_API_KEY).toContain('fake')
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.HOME).toBe(join(run, 'home'))
    expect(fixtureEnvironment(run)).toEqual(env)
    const profile = sandboxProfile(run)
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/security"))')
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
