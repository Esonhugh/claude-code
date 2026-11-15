import { describe, expect, test } from 'bun:test'

// Each module is imported first in its own process, so an import cycle that
// reads a constant before it is initialized fails here.
async function importAlone(specifier: string, probe: string): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', '-e', `const m = await import(${JSON.stringify(specifier)}); console.log(${probe})`],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '' } },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).not.toContain('before initialization')
  expect(exitCode).toBe(0)
  return stdout.trim()
}

describe('REPLTool module isolation', () => {
  test('constants.ts imports on its own', async () => {
    const out = await importAlone(
      new URL('./constants.ts', import.meta.url).pathname,
      'm.REPL_TOOL_NAME, m.CODE_MODE_ONLY_TOOLS.size, m.REPL_PRIMITIVE_TOOL_NAMES.size, m.isReplModeEnabled()',
    )
    expect(out).toBe('REPL 6 8 false')
  }, 30_000)

  test('codeModeGate.ts imports on its own', async () => {
    const out = await importAlone(
      new URL('./codeModeGate.ts', import.meta.url).pathname,
      'm.isCodeModeEnabled(), m.codeModeOnlyToolError("Read")',
    )
    expect(out).toBe('false Read is only available inside REPL. Use REPL with code: await Read({...}).')
  }, 30_000)
})
