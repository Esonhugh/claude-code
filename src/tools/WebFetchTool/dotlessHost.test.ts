import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { getURLMarkdownContent } = await import('./utils.js')

// Like 2.1.311 a dotless host says why, so the model reaches for curl.
test('a hostname without a dot gets an actionable error', async () => {
  for (const url of ['http://localhost:3000/x', 'ftp://x/y']) {
    await expect(getURLMarkdownContent(url, new AbortController())).rejects.toThrow(
      'WebFetch cannot fetch localhost or other hostnames without a dot. To reach a local server, use Bash with curl instead.',
    )
  }
  await expect(getURLMarkdownContent('https://user:pw@example.com/', new AbortController())).rejects.toThrow('Invalid URL')
})
