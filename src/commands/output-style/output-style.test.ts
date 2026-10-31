import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'output-style-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.chdir(root)
const { enableConfigs } = await import('../../utils/config.js')
enableConfigs()
const { setCwd } = await import('../../utils/Shell.js')
setCwd(root)
const { setOriginalCwd, setProjectRoot } = await import('../../bootstrap/state.js')
setOriginalCwd(root)
setProjectRoot(root)
const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
resetSettingsCache()
const { call } = await import('./output-style.js')

const run = async (args: string) =>
  ((await call(args, {} as never)) as { value: string }).value

test('lists the built-in styles like 2.1.311', async () => {
  const listed = await run('')
  expect(listed).toStartWith('Output style: default\n\nAvailable styles:\n- default (current)\n')
  expect(listed).toContain(
    '- Proactive: Claude executes immediately, minimizes interruptions, and prefers action over planning',
  )
  expect(listed).toContain('- Concise: Claude responds tersely')
  expect(listed).toEndWith('\n\nUsage: /output-style <style>')
  expect(await run('nope')).toStartWith(
    'Unknown output style "nope". Available styles: default, Proactive, Concise, Explanatory, Learning',
  )
})

test('a style name is saved to local settings', async () => {
  expect(await run('concise')).toBe('Output style set to Concise')
  const saved = JSON.parse(
    readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'),
  )
  expect(saved.outputStyle).toBe('Concise')
})
