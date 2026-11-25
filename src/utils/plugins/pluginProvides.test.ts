import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pluginLoader from './pluginLoader.js'
import { formatPluginProvides, listPluginProvides } from './pluginProvides.js'
import { validatePluginContents } from './validatePlugin.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function plugin(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-provides-'))
  roots.push(root)
  for (const [path, content] of Object.entries({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'pv' }), ...files })) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const markdown = (name?: string) => `---\n${name ? `name: ${name}\n` : ''}description: d\n---\nbody\n`

// Output of official 2.1.329 `claude plugin validate` on the same folder.
test('lists parts and the hosts they reach like official, without the plugin loader', async () => {
  const loader = spyOn(pluginLoader, 'createPluginFromPath')
  const root = await plugin({
    'hooks/hooks.json': JSON.stringify({
      modules: ['./m.mjs'],
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }, { type: 'http', url: 'https://user:pw@hooks.example.com:8443/x?q=1' }] }],
      },
    }),
    'hooks/m.mjs': 'export function register(on) { on("session.start", async ($) => { await $.process.run({ command: "ls" }) }) }',
    '.mcp.json': JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['s.js'] }, web: { type: 'http', url: 'https://mcp.example.com/v1?k=1' }, slot: { type: 'sse', url: 'https://${HOST}/sse' } } }),
    '.lsp.json': JSON.stringify({ ls1: { command: 'pyright', extensionToLanguage: { '.py': 'python' } } }),
    'skills/sk1/SKILL.md': markdown('sk1'),
    'commands/cmd1.md': markdown(),
    'agents/ag1.md': markdown('ag1'),
    'output-styles/st1.md': markdown('st1'),
  })
  try {
    const listing = await listPluginProvides(root, await validatePluginContents(root))
    expect(loader).not.toHaveBeenCalled()
    expect(formatPluginProvides(listing!.provides)).toEqual([
      'modules: hooks/m.mjs',
      'hooks: PreToolUse Bash command "echo hi"',
      'hooks: Stop command "echo bye"',
      'hooks: Stop http https://hooks.example.com:8443/x',
      'mcpServers: slot sse https://${HOST}/sse',
      'mcpServers: srv stdio node ["s.js"]',
      'mcpServers: web http https://mcp.example.com/v1',
      'lspServers: ls1 pyright',
      'skills: pv:sk1',
      'commands: pv:cmd1',
      'agents: pv:ag1',
      'outputStyles: pv:st1',
    ])
    expect(listing!.hosts).toEqual([
      'Hosts: hooks.example.com:8443, mcp.example.com',
      'Hosts not read for: modules (1), hooks (2), mcpServers (2), lspServers (1), skills (1), commands (1)',
      'Hosts not declared: list what these parts reach under "network.hosts" in plugin.json',
    ])
  } finally {
    loader.mockRestore()
  }
})

// Official 2.1.329 reads the host of a literal URL, a const naming one, or a template up to its first unread substitution.
test('a module names the hosts its literal URLs reach like official', async () => {
  const root = await plugin({
    'hooks/hooks.json': JSON.stringify({ modules: ['./m.mjs'] }),
    'hooks/m.mjs': [
      'const U = "https://c.example.com:8443/p"',
      'const T = `wss://t.example.com/${U}`',
      'export function register(on) { on("session.start", async ($, e) => {',
      '  await $.http.fetch(U); await $.http.fetch(`https://s.example.com/${e.x}`); await $.http.fetch(`https://${e.h}/x`); await $.http.fetch(T, { method: "GET" })',
      '  await $.http.fetch("https://a.example.com", { socketPath: "/tmp/s" }); await $.http.fetch("https://b.example.com", { ...e.o })',
      '  await $.audio.play({ url: "https://snd.example.com/x.mp3" }); await $.audio.play({ file: "./a.mp3" })',
      '}) }',
    ].join('\n'),
  })
  const listing = await listPluginProvides(root, await validatePluginContents(root))
  expect(listing!.hosts).toEqual([
    'Hosts: b.example.com, c.example.com:8443, s.example.com, snd.example.com, t.example.com',
    'Hosts not read for: modules (1)',
  ])
})

test('a plugin of markdown parts alone reaches no host it names', async () => {
  const root = await plugin({ 'skills/sk1/SKILL.md': markdown('sk1'), 'commands/cmd1.md': markdown() })
  const listing = await listPluginProvides(root, [])
  expect(formatPluginProvides(listing!.provides)).toEqual(['skills: pv:sk1', 'commands: pv:cmd1'])
  expect(listing!.hosts).toEqual(['Hosts not read for: skills (1), commands (1)'])
})

test('an unreadable hooks file leaves the listing out', async () => {
  const root = await plugin({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'pv', hooks: './extra.json' }), 'extra.json': '{' })
  expect(await listPluginProvides(root, [])).toBeNull()
})
