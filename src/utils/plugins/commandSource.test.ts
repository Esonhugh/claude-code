import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSourceConsentKey, installFromCommand } from './commandSource.js'
import { copyDir } from './pluginLoader.js'
import type { CommandPluginSource } from './schemas.js'

async function producer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'command-source-'))
  await mkdir(join(dir, '.claude-plugin'))
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'made' }))
  await mkdir(join(dir, 'skills'))
  await writeFile(join(dir, 'skills', 'SKILL.md'), 'x')
  return dir
}

async function target(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'command-target-')), 'out')
}

function install(source: CommandPluginSource, out: string, consent: string | undefined = commandSourceConsentKey(source)) {
  return installFromCommand(source, out, { consent, pluginId: 'made@m', copyDir })
}

describe('command plugin source', () => {
  test('refuses to run a command the user has not reviewed', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'command-marker-')), 'ran')
    const source: CommandPluginSource = { source: 'command', command: `touch ${marker}` }
    await expect(installFromCommand(source, await target(), { consent: undefined, pluginId: 'made@m', copyDir })).rejects.toThrow(/has not been reviewed/)
    await expect(install(source, await target(), 'other command')).rejects.toThrow(/changed the command/)
    await expect(lstat(marker)).rejects.toThrow()
  })

  test('the link mode is part of what was reviewed', async () => {
    const source: CommandPluginSource = { source: 'command', command: 'echo /', mode: 'link' }
    await expect(install(source, await target(), 'echo /')).rejects.toThrow(/changed the command/)
  })

  test('copies the printed directory and versions it by content', async () => {
    const dir = await producer()
    const out = await target()
    const first = await install({ source: 'command', command: `echo ${dir}` }, out)
    expect(await readFile(join(out, 'skills', 'SKILL.md'), 'utf8')).toBe('x')
    expect((await lstat(join(out, 'skills'))).isSymbolicLink()).toBe(false)
    await writeFile(join(dir, 'skills', 'SKILL.md'), 'y')
    const second = await install({ source: 'command', command: `echo ${dir}` }, await target())
    expect(second.contentVersion).not.toBe(first.contentVersion)
  })

  test('link mode links each top-level entry in place', async () => {
    const dir = await producer()
    const out = await target()
    await install({ source: 'command', command: `echo ${dir}`, mode: 'link' }, out)
    expect(await readlink(join(out, 'skills'))).toBe(join(dir, 'skills'))
  })

  test.each([
    ['printed nothing', 'true', /printed nothing/],
    ['printed two lines', 'printf "/a\\n/b\\n"', /exactly one absolute path/],
    ['printed a relative path', 'echo relative/dir', /not an absolute path/],
    ['failed', 'echo boom >&2; exit 3', /failed.*boom/],
    ['printed a directory without plugin content', 'echo /proc/self/fd', /no plugin content/],
    ['printed the working directory', `echo ${process.cwd()}`, /working directory or one of its parents/],
  ])('rejects a command that %s', async (_name, command, message) => {
    await expect(install({ source: 'command', command }, await target())).rejects.toThrow(message)
  })

  test('stops a command that runs past its timeout', async () => {
    const started = Date.now()
    await expect(install({ source: 'command', command: 'sleep 5; echo /', timeout: 1 }, await target())).rejects.toThrow(/did not finish within 1s/)
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
