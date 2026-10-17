import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'CONDENSED_LOGO_LAYOUT_CHILD'

if (!process.env[childKey]) {
  async function runScenario(
    scenario: 'tall' | 'wide' | 'tabbed' | 'narrow' | 'tiny',
    clawd?: string,
  ) {
    const home = mkdtempSync(join(tmpdir(), 'condensed-logo-'))
    if (clawd !== undefined) writeFileSync(join(home, 'clawd.txt'), clawd)

    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_CONFIG_DIR: home,
          CLAUDE_CODE_NO_FLICKER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          ANTHROPIC_API_KEY: 'test-key',
          IS_DEMO: '1',
          [childKey]: scenario,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  test('custom Clawd reserves its full painted height', () =>
    runScenario(
      'tall',
      Array.from({ length: 8 }, (_, index) =>
        `CUSTOM_ROW_${String(index + 1).padStart(2, '0')}_END`,
      ).join('\n'),
    ), 30000)

  test('wide custom Clawd stacks without wrapping into main content', () =>
    runScenario(
      'wide',
      Array.from(
        { length: 3 },
        (_, index) => `WIDE_${index + 1}_${'Z'.repeat(180)}_END`,
      ).join('\n'),
    ), 30000)

  test('custom Clawd measures tabs using their painted width', () =>
    runScenario('tabbed', '\tX\n\tY\n\tZ'), 30000)

  test('builtin animated Clawd keeps its three-row footprint in a narrow terminal', () =>
    runScenario('narrow'), 30000)

  test('logo info rows stay bounded in an extremely narrow terminal', () =>
    runScenario('tiny'), 30000)
} else {
  const React = await import('react')
  const { Writable } = await import('node:stream')
  const { Box, Text, render } = await import('../../ink.js')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { CondensedLogo } = await import('./CondensedLogo.js')
  const {
    applyTerminalOutput,
    createTerminalScreenRenderer,
    renderedPreview,
  } = await import('../../utils/pty/terminalScreenRenderer.js')

  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: '0.0.0-test',
  }

  class Output extends Writable {
    columns = process.env[childKey] === 'wide'
      ? 60
      : process.env[childKey] === 'tabbed'
        ? 24
      : process.env[childKey] === 'narrow'
        ? 8
        : process.env[childKey] === 'tiny'
          ? 4
          : 100
    rows = 30
    isTTY = true
    screen = createTerminalScreenRenderer(this.columns, this.rows)

    _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
      applyTerminalOutput(this.screen, chunk.toString())
      done()
    }
  }

  const stdout = new Output()
  const instance = await render(
    <AppStateProvider>
      <Box width={stdout.columns} flexDirection="column">
        <CondensedLogo />
        <Text>MAIN_CONTENT_MARKER</Text>
      </Box>
    </AppStateProvider>,
    { stdout: stdout as never, patchConsole: false },
  )
  await new Promise(resolve => setImmediate(resolve))

  const lines = renderedPreview(stdout.screen).split('\n')
  if (process.env[childKey] === 'tall') {
    for (let index = 0; index < 8; index += 1) {
      expect(lines[index]).toContain(
        `CUSTOM_ROW_${String(index + 1).padStart(2, '0')}_END`,
      )
    }
    expect(lines[8]).toBe('MAIN_CONTENT_MARKER')
  } else if (process.env[childKey] === 'wide') {
    for (let index = 0; index < 3; index += 1) {
      expect(lines[index]).toStartWith(`WIDE_${index + 1}_`)
    }
    expect(lines.filter(line => /^Z/u.test(line))).toHaveLength(0)
    expect(lines.every(line => line.length <= stdout.columns)).toBe(true)
    const infoRow = lines.findIndex(line => line.includes('EsonClaw'))
    const markerRow = lines.indexOf('MAIN_CONTENT_MARKER')
    expect(infoRow).toBeGreaterThanOrEqual(3)
    expect(markerRow).toBeGreaterThan(infoRow)
    expect(lines.slice(0, markerRow).every(line =>
      !line.includes('WIDE_') || !line.includes('EsonClaw'),
    )).toBe(true)
  } else if (process.env[childKey] === 'tabbed') {
    expect(lines.slice(0, 3)).toEqual(['X', '        Y', '        Z'])
    expect(lines.findIndex(line => line.startsWith('Eson'))).toBe(4)
    expect(lines.findIndex(line => line.startsWith('MAIN'))).toBeGreaterThan(4)
  } else if (process.env[childKey] === 'narrow') {
    expect(lines.slice(0, 3)).toEqual(['▐▛███▜▌', '▝▜█████…', '  ▘▘ ▝▝…'])
    const infoRow = lines.findIndex(line => line.startsWith('Eson'))
    const markerRow = lines.findIndex(line => line.startsWith('MAIN_'))
    expect(infoRow).toBe(4)
    expect(markerRow).toBeGreaterThan(infoRow)
  } else {
    const markerRow = lines.findIndex(line => line.startsWith('MAIN'))
    expect(markerRow).toBeGreaterThanOrEqual(0)
    expect(markerRow).toBeLessThanOrEqual(8)
  }

  instance.unmount()
  instance.cleanup()
}
