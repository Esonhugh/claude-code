import { expect, test } from 'bun:test'
import { INITIAL_STATE, parseMultipleKeypresses } from './parse-keypress.js'
import { kittyKeyboard, TerminalQuerier } from './terminal-querier.js'

test('a CSI ? flags u reply answers the Kitty keyboard query', async () => {
  const querier = new TerminalQuerier({ write: () => true } as unknown as NodeJS.WriteStream)
  const result = querier.send(kittyKeyboard())
  const flushed = querier.flush()
  const [items] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[?0u\x1b[?62;22c')
  for (const item of items) if (item.kind === 'response') querier.onResponse(item.response)
  expect(await result).toEqual({ type: 'kittyKeyboard', flags: 0 })
  await flushed
})

test('a terminal outside the allowlist gets extended keys once it answers the query', () => {
  const source = `import * as t from ${JSON.stringify(new URL('./terminal.ts', import.meta.url).pathname)}; const before = t.supportsExtendedKeys(); t.setExtendedKeysDetected(); console.log(JSON.stringify([before, t.supportsExtendedKeys()]))`
  const env: Record<string, string | undefined> = { ...process.env, TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' }
  for (const key of ['TMUX', 'KITTY_WINDOW_ID', 'WT_SESSION', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_EXECUTABLE', 'ITERM_SESSION_ID']) delete env[key]
  const child = Bun.spawnSync([process.execPath, '--eval', source], { env })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(JSON.parse(child.stdout.toString())).toEqual([false, true])
})
