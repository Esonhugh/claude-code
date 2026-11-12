import { expect, test } from 'bun:test'
import { join } from 'path'

// An unwritable --debug-file must not take the CLI down: debug logging is
// best effort, and every logForDebugging call site would otherwise throw.
test.each(['/proc/nonexistent/debug.txt', '/dev/full'])(
  'logForDebugging survives an unwritable --debug-file (%s)',
  path => {
    const script = `
      const { logForDebugging } = await import(${JSON.stringify(join(import.meta.dir, 'debug.ts'))})
      logForDebugging('first line')
      logForDebugging('second line')
      console.log('still-running')
    `
    const r = Bun.spawnSync(
      [process.execPath, '-e', script, '--', '--debug-file', path],
      { env: { ...process.env, NODE_ENV: 'production' }, stderr: 'pipe' },
    )
    expect(r.stderr.toString()).not.toContain('Error')
    expect(r.stdout.toString()).toContain('still-running')
    expect(r.exitCode).toBe(0)
  },
)
