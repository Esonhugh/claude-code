import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A save re-reads ~/.claude.json under the lock; a read that fails must not
// make the defaults the base of what is written back.
const stored = { numStartups: 37, editorMode: 'vim', marker: 'KEEP' }

if (!process.env.CONFIG_READ_FAILURES) {
  // NODE_ENV=test replaces the config with an in-memory stub, so each case is its own process.
  async function save(failures: string) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'config-read-error-')))
    const configDir = join(home, 'config')
    mkdirSync(configDir)
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify(stored))
    const child = Bun.spawn([process.execPath, import.meta.path], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CONFIG_READ_FAILURES: failures },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return { saved: stdout.trim(), disk: JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) }
  }

  test('a save whose re-read fails once keeps the stored config', async () => {
    expect(await save('once')).toEqual({ saved: 'true', disk: { ...stored, numStartups: 38 } })
  }, 60000)

  test('a save whose re-read keeps failing builds on the config this process read', async () => {
    // The base is the loaded config, which also carries the fields the load migrated in.
    expect(await save('after-load')).toMatchObject({ saved: 'true', disk: { ...stored, numStartups: 38 } })
  }, 60000)

  test('a config that was never readable is not written, and the save says so', async () => {
    expect(await save('always')).toEqual({ saved: 'false', disk: stored })
  }, 60000)
} else {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('./config.js')
  const { getGlobalClaudeFile } = await import('./env.js')
  const { getFsImplementation, setFsImplementation } = await import('./fsOperations.js')
  enableConfigs()
  const fs = getFsImplementation()
  let failures = { once: 1, 'after-load': Infinity, always: Infinity }[process.env.CONFIG_READ_FAILURES!]!
  const failReads = () => setFsImplementation({
    ...fs,
    readFileSync: ((path: string, options: { encoding: BufferEncoding }) => {
      if (path === getGlobalClaudeFile() && failures-- > 0) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      return fs.readFileSync(path, options)
    }) as typeof fs.readFileSync,
  })
  if (process.env.CONFIG_READ_FAILURES === 'always') failReads()
  getGlobalConfig()
  failReads()
  const saved = saveGlobalConfig(current => ({ ...current, numStartups: current.numStartups + 1 }))
  process.stdout.write(String(saved))
}
