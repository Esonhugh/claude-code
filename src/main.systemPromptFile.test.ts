import { expect, test } from 'bun:test'

const source = await Bun.file(new URL('./main.tsx', import.meta.url)).text()
const block = source.slice(
  source.indexOf('      // Handle system prompt options'),
  source.indexOf('      // Handle append system prompt options'),
)

function resolveSystemPrompt(flag: string | undefined, file: string | undefined) {
  const stderr: string[] = []
  const systemPrompt = new Function(
    'options', 'resolve', 'readFileSync', 'getErrnoCode', 'errorMessage', 'chalk', 'process',
    `${block}\nreturn systemPrompt`,
  )(
    { systemPrompt: flag, systemPromptFile: file === undefined ? undefined : 'sp.txt' },
    (path: string) => path,
    () => file,
    () => undefined,
    String,
    { red: (text: string) => text },
    {
      stderr: { write: (text: string) => stderr.push(text) },
      exit: (code: number) => { throw new Error(`exit ${code}: ${stderr.join('')}`) },
    },
  )
  return systemPrompt
}

test('--system-prompt-file with --system-prompt puts the file first, like 2.1.329', () => {
  expect(resolveSystemPrompt('A', 'SPF')).toBe('SPF\n\nA')
  expect(resolveSystemPrompt('A', 'SPF\n')).toBe('SPF\n\nA')
  expect(resolveSystemPrompt('A', 'SPF\n\n\n')).toBe('SPF\n\n\n\nA')
  expect(resolveSystemPrompt(' A ', '  SPF  ')).toBe('  SPF  \n\n A ')
  expect(resolveSystemPrompt('A', '\n\n')).toBe('\n\n\nA')
})

test('an empty side leaves the other one unchanged', () => {
  expect(resolveSystemPrompt('A', '')).toBe('A')
  expect(resolveSystemPrompt('', 'SPF\n')).toBe('SPF\n')
  expect(resolveSystemPrompt(undefined, 'SPF\n')).toBe('SPF\n')
  expect(resolveSystemPrompt('A', undefined)).toBe('A')
})
