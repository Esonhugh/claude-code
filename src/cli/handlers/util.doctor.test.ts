import { expect, spyOn, test } from 'bun:test'

const { doctorHandler } = await import('./util.js')

test('claude doctor without a terminal to read keys from exits with a message instead of hanging', async () => {
  const previousCI = process.env.CI
  const previousTTY = process.stdin.isTTY
  process.env.CI = 'true'
  process.stdin.isTTY = false
  const err: string[] = []
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => (err.push(String(chunk)), true))
  const exit = spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`exit ${code}`)
  })
  let rendered = false
  const root = { render: () => void (rendered = true), unmount: () => {}, waitUntilExit: async () => {} }
  try {
    const outcome = await Promise.race([
      doctorHandler(root).then(() => 'resolved', e => String(e)),
      Bun.sleep(3000).then(() => 'hung'),
    ])
    expect(outcome).toBe('Error: exit 1')
    expect(rendered).toBe(false)
    expect(err.join('')).toContain('claude doctor needs an interactive terminal')
  } finally {
    stderr.mockRestore()
    exit.mockRestore()
    process.stdin.isTTY = previousTTY
    if (previousCI === undefined) delete process.env.CI
    else process.env.CI = previousCI
  }
})
