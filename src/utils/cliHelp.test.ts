import { expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { formatHelp } from './cliHelp.js'

// Expected text is 2.1.311's `claude --help` at 80 columns.
test('wraps descriptions at 80 columns and moves long terms to their own line', () => {
  const program = new Command('claude')
    .configureHelp({ formatHelp, helpWidth: 80 })
    .option('--add-dir <directories...>', 'Additional directories to allow tool access to')
    .option('--allowedTools, --allowed-tools <tools...>', 'Comma or space-separated list of tool names to allow (e.g. "Bash(git *) Edit")')
    .option('--allow-dangerously-skip-permissions', 'Enable bypassing all permission checks as an option, without it being enabled by default.')
  expect(program.helpInformation()).toBe(`Usage: claude [options]

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks
                                        as an option, without it being enabled
                                        by default.
  -h, --help                            display help for command
`)
})
