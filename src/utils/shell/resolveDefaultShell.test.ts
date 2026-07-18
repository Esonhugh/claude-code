import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'

import {
  resolveTerminalCommand,
  setShellSettingsOverrideForTesting,
} from './resolveDefaultShell.js'

function executable(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(path, 0o755)
  return path
}

afterEach(() => {
  setShellSettingsOverrideForTesting(undefined)
})

test('resolveTerminalCommand resolves bare commands with merged env PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-path-'))
  try {
    const commandPath = executable(dir, 'custom-shell')

    assert.deepEqual(
      resolveTerminalCommand({ command: 'custom-shell', env: { PATH: dir } }),
      { command: commandPath, args: [] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand resolves relative path commands from input cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-cwd-'))
  try {
    const commandPath = executable(dir, 'built-claude')

    assert.deepEqual(
      resolveTerminalCommand({ command: './built-claude', cwd: dir, env: { PATH: '' } }),
      { command: commandPath, args: [] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand resolves absolute executable commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-absolute-'))
  try {
    const commandPath = executable(dir, 'absolute-tool')

    assert.deepEqual(
      resolveTerminalCommand({ command: commandPath, env: { PATH: '' } }),
      { command: commandPath, args: [] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand uses env SHELL for undefined, empty, and blank command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-shell-'))
  try {
    const shellPath = executable(dir, 'shell')

    assert.deepEqual(
      resolveTerminalCommand({ command: undefined, env: { SHELL: shellPath } }),
      { command: shellPath, args: [] },
    )
    assert.deepEqual(
      resolveTerminalCommand({ command: '', env: { SHELL: shellPath } }),
      { command: shellPath, args: [] },
    )
    assert.deepEqual(
      resolveTerminalCommand({ command: '   ', env: { SHELL: shellPath } }),
      { command: shellPath, args: [] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand returns PowerShell default args for implicit and explicit shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-pwsh-'))
  try {
    const pwshPath = executable(dir, 'pwsh')

    assert.deepEqual(
      resolveTerminalCommand({ command: undefined, env: { SHELL: pwshPath } }),
      { command: pwshPath, args: ['-NoLogo'] },
    )
    assert.deepEqual(
      resolveTerminalCommand({ command: pwshPath, env: { SHELL: pwshPath } }),
      { command: pwshPath, args: ['-NoLogo'] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand treats blank command as default shell but does not trim nonblank command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-command-'))
  try {
    const bashPath = executable(dir, 'bash')
    assert.deepEqual(
      resolveTerminalCommand({ command: '   ', env: { PATH: dir, SHELL: '' } }),
      { command: bashPath, args: [] },
    )
    assert.throws(
      () => resolveTerminalCommand({ command: ` ${bashPath} `, env: { PATH: dir } }),
      /Unable to resolve terminal command:/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand powershell fallback prefers pwsh then powershell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-powershell-'))
  try {
    const pwshPath = executable(dir, 'pwsh')
    executable(dir, 'powershell')
    setShellSettingsOverrideForTesting({ defaultShell: 'powershell' })

    assert.deepEqual(
      resolveTerminalCommand({ env: { PATH: dir, SHELL: '' } }),
      { command: pwshPath, args: ['-NoLogo'] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand powershell fallback uses powershell when pwsh is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-powershell-fallback-'))
  try {
    const powershellPath = executable(dir, 'powershell')
    setShellSettingsOverrideForTesting({ defaultShell: 'powershell' })

    assert.deepEqual(
      resolveTerminalCommand({ env: { PATH: dir, SHELL: '' } }),
      { command: powershellPath, args: ['-NoLogo'] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTerminalCommand recognizes PowerShell Unix and Windows absolute basenames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-explicit-powershell-'))
  try {
    const powershellExePath = executable(dir, 'powershell.exe')

    assert.deepEqual(resolveTerminalCommand({ command: powershellExePath }), {
      command: powershellExePath,
      args: ['-NoLogo'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
