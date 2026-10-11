import { expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'

async function command() {
  const { createPluginDirNoMcpOption } = await import('./pluginOptions.js')
  return new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .addOption(createPluginDirNoMcpOption())
}

// Official 2.1.292 native: hidden, repeatable, single-value top-level option.
test('no-MCP plugin directories default to an empty list', async () => {
  const cli = await command()
  cli.parse([], { from: 'user' })
  expect(cli.getOptionValue('pluginDirNoMcp')).toEqual([])
})

test('no-MCP directories collect separately and leave the following prompt intact', async () => {
  const cli = (await command())
    .option('--plugin-dir <path>', 'Plugin', (path: string, paths: string[]) => [...paths, path], [] as string[])
    .argument('[prompt]')
  cli.parse(['--plugin-dir-no-mcp', 'first', '--plugin-dir', 'normal', '--plugin-dir-no-mcp', 'second', 'hello'], { from: 'user' })
  expect(cli.getOptionValue('pluginDirNoMcp')).toEqual(['first', 'second'])
  expect(cli.getOptionValue('pluginDir')).toEqual(['normal'])
  expect(cli.args).toEqual(['hello'])
})

test('a no-MCP directory does not consume the subcommand words', async () => {
  const cli = (await command()).enablePositionalOptions()
  let called = false
  cli.command('mcp').command('list').action(() => { called = true })
  cli.parse(['--plugin-dir-no-mcp', 'plugin', 'mcp', 'list'], { from: 'user' })
  expect(called).toBe(true)
  expect(cli.getOptionValue('pluginDirNoMcp')).toEqual(['plugin'])
})

test('the no-MCP option remains absent from public help', async () => {
  const cli = (await command()).option('--plugin-dir <path>', 'Plugin')
  expect(cli.helpInformation()).toContain('--plugin-dir <path>')
  expect(cli.helpInformation()).not.toContain('--plugin-dir-no-mcp')
})

test('a missing no-MCP path produces a normal Commander argument error', async () => {
  const cli = await command()
  expect(() => cli.parse(['--plugin-dir-no-mcp'], { from: 'user' })).toThrow('argument missing')
})
