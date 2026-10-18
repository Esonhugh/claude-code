import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

// Official 2.1.292 AJe/Oyn: --bare still honors explicitly requested session
// plugins from --plugin-dir, --plugin-dir-no-mcp and --plugin-url.
const childSource = [
  "import assert from 'node:assert/strict'",
  "import {mkdir,writeFile} from 'node:fs/promises'",
  "import {join} from 'node:path'",
  'const state=await import(' + JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href) + ')',
  'state.setOriginalCwd(process.cwd());state.setProjectRoot(process.cwd());state.setCwdState(process.cwd())',
  'const {enableConfigs}=await import(' + JSON.stringify(new URL('../config.ts', import.meta.url).href) + ');enableConfigs()',
  "const plugin=join(process.cwd(),'no-mcp-plugin')",
  "await mkdir(join(plugin,'.claude-plugin'),{recursive:true});await mkdir(join(plugin,'commands'),{recursive:true})",
  "await writeFile(join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name:'session-probe',version:'1.0.0'}))",
  "await writeFile(join(plugin,'commands/hello.md'),'---\\ndescription: Bare probe\\n---\\nHELLO\\n')",
  "if(process.env.BARE_CASE==='url')state.setInlinePluginUrls([process.env.BARE_PLUGIN_URL]);else state.setInlinePluginsNoMcp([plugin])",
  'const {getPluginCommands}=await import(' + JSON.stringify(new URL('./loadPluginCommands.ts', import.meta.url).href) + ')',
  "const names=(await getPluginCommands()).map(c=>c.name)",
  "assert.ok(names.includes('session-probe:hello'),'session plugin command missing in bare mode: '+names.join(','))",
].join('\n')

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => new Response(Buffer.from(zipSync({
    '.claude-plugin/plugin.json': strToU8(JSON.stringify({ name: 'session-probe', version: '1.0.0' })),
    'commands/hello.md': strToU8('---\ndescription: Bare probe\n---\nHELLO\n'),
  }))),
})

for (const scenario of ['url', 'no-mcp']) {
  test('bare mode loads explicitly requested session plugins: ' + scenario, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'plugin-bare-')))
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', childSource], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        CLAUDE_CONFIG_DIR: join(directory, 'config'),
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        XDG_CACHE_HOME: join(directory, 'cache'),
        TMPDIR: directory,
        CLAUDE_CODE_SIMPLE: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        BARE_CASE: scenario,
        BARE_PLUGIN_URL: `http://127.0.0.1:${server.port}/session-probe.zip`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stdout + stderr).toBe(0)
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
