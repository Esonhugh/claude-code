import { expect, test } from 'bun:test'

// isUltrathinkEnabled sits behind the ULTRATHINK build feature, which `bun test`
// leaves off, so each case runs in a child with the feature on.
const childFlag = 'CLAUDE_CODE_ULTRATHINK_TEST_CHILD'

async function enabledInChild(disable: string | undefined): Promise<boolean> {
  const env: Record<string, string | undefined> = { ...process.env, [childFlag]: '1' }
  delete env.CLAUDE_CODE_DISABLE_ULTRATHINK
  if (disable !== undefined) env.CLAUDE_CODE_DISABLE_ULTRATHINK = disable
  const child = Bun.spawn([process.execPath, '--feature=ULTRATHINK', import.meta.path], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null')
}

if (process.env[childFlag] === '1') {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
  const { isUltrathinkEnabled } = await import('./thinking.js')
  console.log(JSON.stringify(isUltrathinkEnabled()))
} else {
  test('ultrathink stays on when CLAUDE_CODE_DISABLE_ULTRATHINK is unset or false', async () => {
    expect(await enabledInChild(undefined)).toBe(true)
    expect(await enabledInChild('0')).toBe(true)
  })

  test('CLAUDE_CODE_DISABLE_ULTRATHINK turns ultrathink off', async () => {
    expect(await enabledInChild('1')).toBe(false)
    expect(await enabledInChild('true')).toBe(false)
  })
}
