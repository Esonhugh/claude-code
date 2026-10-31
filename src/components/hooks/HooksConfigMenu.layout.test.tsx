import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { getHookEventMetadata } from '../../utils/hooks/hooksConfigManager.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js'
import { HooksListMode } from './HooksListMode.js'
import { SelectEventMode } from './SelectEventMode.js'
import { ViewHookMode } from './ViewHookMode.js'

const pre: IndividualHookConfig = {
  event: 'PreToolUse',
  config: { type: 'command', command: 'echo pre' },
  matcher: 'Bash',
  source: 'userSettings',
}
const stop: IndividualHookConfig = {
  event: 'Stop',
  config: { type: 'command', command: 'echo stop' },
  source: 'userSettings',
}
const hooksByEventAndMatcher = {
  PreToolUse: { Bash: [pre] },
  Stop: { '': [stop] },
} as unknown as Record<HookEvent, Record<string, IndividualHookConfig[]>>

async function renderTo(node: React.ReactNode) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))
  await settle()
  return {
    lines: () => stripAnsi(output).split('\n'),
    press: async (key: string) => { stdin.write(key); await settle() },
    unmount: () => instance.unmount(),
  }
}

test('the /hooks top level lists configured hooks grouped by event', async () => {
  const selected: string[] = []
  const view = await renderTo(
    <HooksListMode
      hookEventMetadata={getHookEventMetadata([])}
      hooksByEventAndMatcher={hooksByEventAndMatcher}
      restrictedByPolicy={false}
      defaultFocusIndex={0}
      onFocusRow={() => {}}
      onSelectHook={hook => selected.push(hook.config.type === 'command' ? hook.config.command : '')}
      onOpenEvents={() => selected.push('events')}
      onCancel={() => {}}
    />,
  )
  try {
    const text = view.lines().join('\n')
    expect(text).toContain('2 hooks on 2 events')
    expect(text).toContain('This menu is read-only. To add or change a hook, edit settings.json or ask Claude.')
    expect(text).toContain('PreToolUse  before tool execution')
    expect(text).toContain('Stop  right before Claude concludes its response')
    expect(text).toContain('[User] echo pre    Bash · command')
    expect(text).toContain('[User] echo stop   command')
    expect(text).toContain('All events')
    expect(text).toContain('Enter to view · Esc to close')

    await view.press('\r')
    await view.press('\u001B[B')
    await view.press('\u001B[B')
    await view.press('\r')
    expect(selected).toEqual(['echo pre', 'events'])
  } finally {
    view.unmount()
  }
})

test('a long hook command is truncated so the type column stays on one line', async () => {
  const long: IndividualHookConfig = {
    event: 'Stop',
    config: { type: 'command', command: `cat >> /tmp/${'x'.repeat(120)}/hooks.log` },
    source: 'userSettings',
  }
  const view = await renderTo(
    <HooksListMode
      hookEventMetadata={getHookEventMetadata([])}
      hooksByEventAndMatcher={{ Stop: { '': [long] } } as unknown as Record<HookEvent, Record<string, IndividualHookConfig[]>>}
      restrictedByPolicy={false}
      defaultFocusIndex={0}
      onFocusRow={() => {}}
      onSelectHook={() => {}}
      onOpenEvents={() => {}}
      onCancel={() => {}}
    />,
  )
  try {
    const lines = view.lines()
    const row = lines.find(line => line.includes('[User] cat >>'))
    expect(row).toMatch(/…\s{3}command\s*$/)
    expect(lines.some(line => line.trim() === 'and' || line.trim() === 'nd')).toBe(false)
  } finally {
    view.unmount()
  }
})

test('All events lists every event with its hook count', async () => {
  const view = await renderTo(
    <SelectEventMode
      hookEventMetadata={getHookEventMetadata([])}
      hooksByEvent={{ PreToolUse: 1, Stop: 1 }}
      onSelectEvent={() => {}}
      onCancel={() => {}}
    />,
  )
  try {
    const lines = view.lines()
    const text = lines.join('\n')
    expect(text).toContain('Hook events')
    expect(text).toMatch(/\d+ events · 2 with hooks/)
    const row = lines.findIndex(line => line.includes('PreToolUse   1 hook'))
    expect(row).toBeGreaterThan(-1)
    expect(lines[row + 1]).toContain('Before tool execution')
    expect(text).toContain('more')
    expect(text).toContain('Enter to open · Esc to go back')
  } finally {
    view.unmount()
  }
})

test('the hook detail view is titled by hook type', async () => {
  const view = await renderTo(
    <ViewHookMode selectedHook={pre} eventSupportsMatcher onCancel={() => {}} />,
  )
  try {
    const text = view.lines().join('\n')
    expect(text).toContain('Command hook')
    expect(text).toContain('PreToolUse · Bash')
    expect(text).toContain('Source:  User settings (~/.claude/settings.json)')
    expect(text).toContain('echo pre')
    expect(text).toMatch(/To change or remove this hook, edit .*settings\.json or ask Claude\./)
    expect(text).toContain('Esc to go back')
    expect(text).not.toContain('Hook details')
  } finally {
    view.unmount()
  }
})
