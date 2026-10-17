import { describe, expect, test } from 'bun:test'

// main.tsx cannot be imported under bun (feature() at main.tsx:2647 is
// outside an if/ternary), so execute the real main() prologue the same way
// main.model.test.ts does.
const source = await Bun.file(new URL('./main.tsx', import.meta.url)).text()
const mainStart = 'export async function main() {'
const prologue = source.slice(
  source.indexOf(mainStart) + mainStart.length,
  source.indexOf("  profileCheckpoint('main_warning_handler_initialized')"),
)

describe('main() startup process listeners', () => {
  test('registers only an exit listener, leaving SIGINT to setupGracefulShutdown', () => {
    const registered: string[] = []
    const fakeProcess = {
      argv: [] as string[],
      env: {} as Record<string, string>,
      exit: () => {
        throw new Error('process.exit must not be reachable from main() prologue')
      },
      on: (event: string) => {
        registered.push(event)
      },
    }
    new Function(
      'process', 'profileCheckpoint', 'initializeWarningHandler', 'resetCursor',
      prologue,
    )(fakeProcess, () => {}, () => {}, () => {})

    expect(registered).toEqual(['exit'])
  })
})
