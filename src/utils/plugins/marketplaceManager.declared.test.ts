import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Declared marketplaces come from process-wide settings, so each case runs in a
// child whose HOME and config dir are owned by this test.
async function declaredFor(enabledPlugins: Record<string, boolean> | undefined) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-declared-')))
  try {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', 'settings.json'), JSON.stringify(enabledPlugins ? { enabledPlugins } : {}))
    const child = Bun.spawn([process.execPath, '-e', `
      globalThis.MACRO = { VERSION: 'test' }
      const { getDeclaredMarketplaces } = await import(${JSON.stringify(join(import.meta.dir, 'marketplaceManager.ts'))})
      console.log(JSON.stringify(Object.keys(getDeclaredMarketplaces()).sort()))
    `], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as string[]
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('Esonhugh-Marketplace is declared only when an enabled plugin references it, like claude-plugins-official', async () => {
  expect(await declaredFor(undefined)).toEqual([])
  expect(await declaredFor({ 'x@Esonhugh-Marketplace': false })).toEqual([])
  expect(await declaredFor({ 'x@Esonhugh-Marketplace': true })).toEqual(['Esonhugh-Marketplace'])
  expect(await declaredFor({ 'x@claude-plugins-official': true })).toEqual(['claude-plugins-official'])
}, 60000)
