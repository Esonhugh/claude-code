import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import {
  formatPluginDetails,
  getPluginInventory,
  measurePluginComponents,
} from './pluginDetails.js'

let root: string
const file = (path: string, content: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-details-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const plugin = (): LoadedPlugin => ({
  name: 'full',
  manifest: {
    name: 'full',
    displayName: 'Full Plugin',
    version: '1.2.3',
    description: 'first line\nsecond line',
  },
  path: root,
  source: 'full@inline',
  repository: 'full@inline',
  commandsPath: join(root, 'commands'),
  agentsPath: join(root, 'agents'),
  skillsPath: join(root, 'skills'),
  hooksConfig: { PreToolUse: [], Stop: [] },
  mcpServers: { srv: { command: 'true', args: [] } },
})

test('plugin details lists what a plugin ships and what it costs', async () => {
  file(
    'skills/alpha/SKILL.md',
    `---\nname: alpha\ndescription: Alpha skill\nwhen_to_use: when testing\n---\n# Alpha\n${'body '.repeat(200)}\n`,
  )
  file('skills/notes/README.md', 'not a skill')
  file('commands/run.md', '---\ndescription: Run the thing\n---\nDo it\n')
  file('commands/sub/deep.md', 'nested commands are not listed')
  file('agents/helper.md', '---\nname: helper\ndescription: Helps\n---\nYou help.\n')
  file('.lsp.json', '{"ls":{"command":"true"}}')

  const inventory = await measurePluginComponents(
    await getPluginInventory(plugin()),
    'full',
  )
  expect(inventory).toMatchObject({
    skills: [
      {
        name: 'alpha',
        // "full:alpha Alpha skill when testing" / the body without frontmatter
        chars: { always_on: 35, on_invoke: 1007 },
      },
    ],
    commands: [{ name: 'run', chars: { always_on: 22, on_invoke: 5 } }],
    agents: [{ name: 'helper', chars: { always_on: 12, on_invoke: 9 } }],
    hooks: ['PreToolUse', 'Stop'],
    mcpServers: ['srv'],
    lspServers: ['ls'],
  })

  expect(formatPluginDetails(plugin(), inventory, undefined)).toBe(
    `Full Plugin (full) 1.2.3
  Description: first line
      second line
  Source: full@inline

Component inventory
  Skills (2)  alpha, run
  Agents (1)  helper
  Hooks (2)  PreToolUse, Stop  (harness-only — no model context cost)
  MCP servers (1)  srv  (tool schemas resolved at runtime; not counted)
  LSP servers (1)  ls  (no model context cost)

Projected token cost
  Always-on:   ~17 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  alpha           < 20       ~250
  helper          < 20       < 20
  run             < 20       < 20

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.`,
  )
  // Counted tokens replace the estimate and are shared out by size.
  expect(
    formatPluginDetails(plugin(), inventory, { always_on: 690, on_invoke: 2042 }),
  ).toContain(`  Always-on:   ~690 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  alpha           ~350        ~2k
  helper          ~120       < 20
  run             ~220       < 20`)
})

test('plugin details shows a plugin with nothing in it', async () => {
  const empty: LoadedPlugin = {
    name: 'plain',
    manifest: { name: 'plain' },
    path: root,
    source: 'plain@inline',
    repository: 'plain@inline',
  }
  expect(
    formatPluginDetails(empty, await getPluginInventory(empty), undefined),
  ).toBe(`plain
  Source: plain@inline

Component inventory
  Skills (0)
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~0 tok   added to every session`)
})
