import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { Command } from '../../commands.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { formatSkillTokens, SkillsMenu } from './SkillsMenu.js'

const skill = (name: string, description: string) =>
  ({ type: 'prompt', name, description, loadedFrom: 'skills', source: 'userSettings', getPromptForCommand: async () => [] }) as unknown as Command

async function renderMenu(commands: Command[]) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const exits: string[] = []
  const instance = await render(
    <AppStateProvider><KeybindingSetup><SkillsMenu commands={commands} onExit={r => exits.push(r ?? '')} /></KeybindingSetup></AppStateProvider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  const settle = () => new Promise(resolve => setTimeout(resolve, 60))
  await settle()
  return {
    screen: () => { const all = stripAnsi(output); return all.slice(all.lastIndexOf('Skills')) },
    press: async (key: string) => { stdin.write(key); await settle() },
    exits,
    unmount: () => instance.unmount(),
  }
}

test('/skills is one searchable list with source and token columns (2.1.311)', async () => {
  const view = await renderMenu([skill('mt-hello', 'say hello'), skill('deploy', 'ship it')])
  try {
    expect(view.screen()).toContain('2 skills · enter/space to cycle, / to search, t to sort, Esc to close')
    expect(view.screen()).toContain('Search skills…')
    expect(view.screen()).toMatch(/mt-hello\s+user · < 20 tok/)
    await view.press('/')
    await view.press('h')
    await view.press('e')
    expect(view.screen()).toContain('1/2 skills')
    expect(view.screen()).toContain('mt-hello')
    expect(view.screen()).not.toContain('deploy  ')
    await view.press('\u001B')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(view.screen()).toContain('2 skills · enter/space')
    await view.press('\u001B')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(view.exits).toEqual(['No changes'])
  } finally {
    view.unmount()
  }
})

test('skill token sizes read like 2.1.311', () => {
  expect(formatSkillTokens(8)).toBe('< 20')
  expect(formatSkillTokens(134)).toBe('~130')
})
