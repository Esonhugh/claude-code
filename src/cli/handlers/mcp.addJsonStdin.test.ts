import { afterEach, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { readMcpJsonFromStdin } from './mcp.js'

const stdin = (chunks: string[], isTTY = false) => Object.assign(Readable.from(chunks.map(chunk => Buffer.from(chunk))), { isTTY })
const childSession = process.env.CLAUDE_CODE_CHILD_SESSION

afterEach(() => {
  if (childSession === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION
  else process.env.CLAUDE_CODE_CHILD_SESSION = childSession
})

test('mcp add-json - reads the JSON piped on stdin', async () => {
  delete process.env.CLAUDE_CODE_CHILD_SESSION
  expect(await readMcpJsonFromStdin(stdin(['{"type":"stdio",', '"command":"echo"}\n']))).toBe('{"type":"stdio","command":"echo"}\n')
})

test('mcp add-json - says what is wrong with stdin instead of reading it', async () => {
  delete process.env.CLAUDE_CODE_CHILD_SESSION
  const noJson = 'There is no JSON on stdin. Pipe it in, or pass it as the argument.'
  await expect(readMcpJsonFromStdin(stdin([' \n']))).rejects.toThrow(noJson)
  await expect(readMcpJsonFromStdin(stdin([]))).rejects.toThrow(noJson)
  await expect(readMcpJsonFromStdin(stdin(['{}'], true))).rejects.toThrow(noJson)
  await expect(readMcpJsonFromStdin(stdin(['{}', ' '.repeat(1048576)]))).rejects.toThrow('The JSON on stdin is over the limit of 1 MiB.')
  process.env.CLAUDE_CODE_CHILD_SESSION = '1'
  await expect(readMcpJsonFromStdin(stdin(['{}']))).rejects.toThrow('Reading the JSON from stdin is refused inside a Claude Code session, because its permission prompt would not show the server. Run the command outside the session.')
})
