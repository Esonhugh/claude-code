import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plugin registry, settings and cache paths are process-wide, so the cases run
// in a child whose HOME and config dir are owned by this test.
if (!process.env.PLUGIN_OPS_COMMAND_SOURCE_TEST_CHILD) {
  test('command plugin sources run only after the user accepts the command', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-cmd-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          PLUGIN_OPS_COMMAND_SOURCE_TEST_CHILD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      console.log(stdout, stderr)
      expect(stderr).toMatch(/(?:^|\n) 4 pass(?:\n|$)/)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(project)
  state.setCwdState(project)
  const mm = await import('../../utils/plugins/marketplaceManager.js')
  const ops = await import('./pluginOperations.js')
  const installed = await import(
    '../../utils/plugins/installedPluginsManager.js'
  )

  const producer = join(root, 'producer')
  mkdirSync(join(producer, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(producer, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'made', version: '1.0.0' }),
  )
  mkdirSync(join(producer, 'skills/s'), { recursive: true })
  writeFileSync(join(producer, 'skills/s/SKILL.md'), '---\nname: s\ndescription: d\n---\nbody')
  const log = join(root, 'ran.log')
  const command = (tag: string) => `echo ${tag} >> ${log}; echo ${producer}`
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])

  const market = join(root, 'mkt')
  mkdirSync(join(market, '.claude-plugin'), { recursive: true })
  const publish = async (tag: string) => {
    writeFileSync(
      join(market, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        name: 'mkt',
        owner: { name: 'x' },
        plugins: [{ name: 'made', source: { source: 'command', command: command(tag) } }],
      }),
    )
    await mm.refreshMarketplace('mkt')
  }
  writeFileSync(
    join(market, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      name: 'mkt',
      owner: { name: 'x' },
      plugins: [{ name: 'made', source: { source: 'command', command: command('first') } }],
    }),
  )
  await mm.addMarketplaceSource({ source: 'directory', path: market })

  const record = () => {
    installed.clearInstalledPluginsCache()
    return installed.loadInstalledPluginsFromDisk().plugins['made@mkt']?.[0]
  }

  test('an install that cannot show the command, or is declined, never runs it', async () => {
    await expect(ops.installPluginOp('made@mkt', 'user')).rejects.toThrow(/has not been reviewed/)
    const declined = await ops.installPluginOp('made@mkt', 'user', {
      confirmCommandSource: async () => false,
    })
    expect(declined).toMatchObject({ success: false })
    expect(ran()).toEqual([])
    expect(record()).toBeUndefined()
  })

  test('an accepted install runs the command and records it', async () => {
    let shown: string | undefined
    const result = await ops.installPluginOp('made@mkt', 'user', {
      confirmCommandSource: async (_id, source) => {
        shown = source.command
        return true
      },
    })
    expect(result.success).toBe(true)
    expect(shown).toBe(command('first'))
    expect(ran()).toEqual(['first'])
    expect(record()?.sourceCommand).toBe(command('first'))
    expect(existsSync(join(record()!.installPath, 'skills/s/SKILL.md'))).toBe(true)
  })

  test('an update without a confirmation refuses a changed command', async () => {
    await publish('second')
    await expect(ops.updatePluginOp('made@mkt', 'user')).rejects.toThrow(/changed the command/)
    expect(ran()).toEqual(['first'])
  })

  test('an accepted changed command is recorded even when the output is unchanged', async () => {
    const result = await ops.updatePluginOp('made@mkt', 'user', {
      confirmCommandSource: async () => true,
    })
    expect(result).toMatchObject({ success: true, alreadyUpToDate: true })
    expect(ran()).toEqual(['first', 'second'])
    expect(record()?.sourceCommand).toBe(command('second'))
    expect((await ops.updatePluginOp('made@mkt', 'user')).success).toBe(true)
    expect(ran()).toEqual(['first', 'second', 'second'])
  })
}
