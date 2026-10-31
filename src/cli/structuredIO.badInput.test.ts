import { expect, spyOn, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { StructuredIO } = await import('./structuredIO.js')

async function firstError(line: string): Promise<string> {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.join(' '))
  })
  const exit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit')
  }) as typeof process.exit)
  try {
    const io = new StructuredIO({
      async *[Symbol.asyncIterator]() {
        yield `${line}\n`
      },
    })
    for await (const _ of io.structuredInput) {
      // drain
    }
  } catch {
    // process.exit
  } finally {
    error.mockRestore()
    exit.mockRestore()
  }
  return errors[0] ?? ''
}

test('an unparsable stream-json line is named by type and size, not echoed, like 2.1.311', async () => {
  expect(await firstError('not json')).toBe(
    'Error parsing streaming input line (type=unknown, 8 chars): SyntaxError',
  )
})

test('a user line without a message reports the missing role', async () => {
  expect(await firstError('{"type":"user"}')).toBe(
    "Error: Expected message role 'user', got 'undefined'",
  )
})
