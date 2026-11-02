import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// End-to-end check of a built binary: `claude web` serving the embedded page,
// a real `claude -p` session against a scripted Messages API, driven from
// Chromium. Opt-in because it needs a compiled binary and Playwright:
//   make build && CLAUDE_WEB_BINARY=$PWD/built-claude \
//     bun test src/web/web.binary.test.ts
const binary = process.env.CLAUDE_WEB_BINARY

const sse = (blocks: Record<string, unknown>[], stop: string) => {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', {
    message: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      out += ev('content_block_start', {
        index,
        content_block: { type: 'text', text: '' },
      })
      // Two deltas so the page has to stitch the stream together.
      const text = String(block.text)
      const half = Math.ceil(text.length / 2)
      for (const part of [text.slice(0, half), text.slice(half)]) {
        out += ev('content_block_delta', {
          index,
          delta: { type: 'text_delta', text: part },
        })
      }
    } else {
      out += ev('content_block_start', {
        index,
        content_block: { ...block, input: {} },
      })
      out += ev('content_block_delta', {
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      })
    }
    out += ev('content_block_stop', { index })
  })
  out += ev('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  return out + ev('message_stop', {})
}

// Rich rendering plus the usual XSS attempts; none of them may execute.
const MARKDOWN_REPLY = [
  '## Report',
  '',
  '| name | score |',
  '| :--- | ----: |',
  '| alpha | 1 |',
  '',
  '```ts',
  'const answer: number = 42',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>',
  '',
  '[click](javascript:window.__xss=3) [safe](https://example.com)',
].join('\n')

describe.skipIf(!binary)('claude web (built binary)', () => {
  let api: ReturnType<typeof Bun.serve>
  let web: ReturnType<typeof Bun.spawn>
  let signInUrl = ''
  let home = ''
  let workspace = ''

  beforeAll(async () => {
    // TOUCH asks for `touch made.txt`; after the tool result the turn ends
    // with WEB_DONE. Anything else gets a plain streamed greeting.
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/messages')) {
          return Response.json({})
        }
        type Block = { type: string }
        const body = (await req.json()) as {
          messages: { role: string; content: string | Block[] }[]
        }
        const last = body.messages.at(-1)!
        const lastBlocks = typeof last.content === 'string' ? [] : last.content
        let blocks: Record<string, unknown>[] = [
          { type: 'text', text: 'Hello from the fake model' },
        ]
        let stop = 'end_turn'
        const lastText = JSON.stringify(last.content)
        const touch = (file: string) => {
          blocks = [
            {
              type: 'tool_use',
              id: `toolu_${file.replace('.', '_')}`,
              name: 'Bash',
              input: { command: `touch ${file}`, description: 'Create file' },
            },
          ]
          stop = 'tool_use'
        }
        if (lastBlocks.some(b => b.type === 'tool_result')) {
          blocks = [{ type: 'text', text: 'WEB_DONE' }]
        } else if (lastText.includes('TOUCH')) {
          touch('made.txt')
        } else if (lastText.includes('DENYME')) {
          touch('denied.txt')
        } else if (lastText.includes('MARKDOWN')) {
          blocks = [{ type: 'text', text: MARKDOWN_REPLY }]
        }
        return new Response(sse(blocks, stop), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })

    home = realpathSync(mkdtempSync(join(tmpdir(), 'web-bin-home-')))
    workspace = join(home, 'workspace')
    mkdirSync(workspace)
    web = Bun.spawn(
      [binary!, 'web', '--no-open', '--port', '0', '--workspace', workspace],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          IS_SANDBOX: '1',
          ANTHROPIC_API_KEY: 'sk-fake',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const reader = (web.stdout as ReadableStream<Uint8Array>).getReader()
    let banner = ''
    while (!/token=\S+/.test(banner)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`claude web exited early: ${banner}`)
      banner += new TextDecoder().decode(value)
    }
    reader.releaseLock()
    signInUrl = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(banner)![0]
  }, 30_000)

  afterAll(() => {
    web?.kill('SIGKILL')
    api?.stop(true)
  })

  it('writes the lock and refuses the page without the token', async () => {
    expect(existsSync(join(home, '.claude', 'web.lock'))).toBe(true)
    const base = new URL(signInUrl).origin
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect(
      (
        await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: { origin: 'http://attacker.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
  })

  it('chats, streams the reply and asks before running a tool', async () => {
    // Playwright is installed for node (globally in the cloud container), not
    // as a project dependency; let node find it.
    const resolved = Bun.spawnSync([
      'node',
      '-p',
      "require.resolve('playwright')",
    ])
    const { chromium } = await import(resolved.stdout.toString().trim())
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text())
      })
      await page.goto(signInUrl)
      expect(new URL(page.url()).search).toBe('')
      await page.getByText('What can I help you with?').waitFor()

      const input = page.getByPlaceholder('Message Claude')
      await input.fill('hi there')
      await input.press('Enter')
      await page.getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      await page.getByText('Claude (Opus 5.5)').first().waitFor()

      await input.fill('please TOUCH a file')
      await input.press('Enter')
      const dialog = page.getByRole('dialog')
      await dialog.getByText('Allow Bash?').waitFor({ timeout: 30_000 })
      expect(await dialog.textContent()).toContain('touch made.txt')
      await dialog.getByRole('button', { name: 'Allow', exact: true }).click()
      await page.getByText('WEB_DONE').waitFor({ timeout: 30_000 })
      expect(existsSync(join(workspace, 'made.txt'))).toBe(true)

      await input.fill('please DENYME')
      await input.press('Enter')
      await dialog.getByText('Allow Bash?').waitFor({ timeout: 30_000 })
      await dialog.getByRole('button', { name: 'Deny' }).click()
      await page.getByText('WEB_DONE').nth(1).waitFor({ timeout: 30_000 })
      expect(existsSync(join(workspace, 'denied.txt'))).toBe(false)

      const dialogs: string[] = []
      page.on('dialog', d => {
        dialogs.push(d.message())
        void d.dismiss()
      })
      await input.fill('show MARKDOWN')
      await input.press('Enter')
      await page.locator('.markdown table').waitFor({ timeout: 30_000 })
      expect(await page.locator('.markdown th').first().textContent()).toBe('name')
      await page.locator('.codeblock pre.shiki').waitFor({ timeout: 30_000 })
      await page.locator('.katex').first().waitFor({ timeout: 30_000 })
      await page.locator('.mermaid svg').waitFor({ timeout: 30_000 })
      expect(await page.locator('a[href^="javascript"]').count()).toBe(0)
      expect(await page.locator('a[href="https://example.com"]').count()).toBe(1)
      expect(await page.getByText('<script>window.__xss=2</script>', { exact: false }).count()).toBe(1)
      expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()
      expect(dialogs).toEqual([])

      const mode = page.getByLabel('Permission mode')
      await mode.selectOption('acceptEdits')
      await page.waitForFunction(
        () => (document.querySelector('select.mode') as HTMLSelectElement | null)?.value === 'acceptEdits',
      )
      expect(await page.getByLabel('Model').count()).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 90_000)

  it('shuts down on SIGTERM and removes the lock', async () => {
    web.kill('SIGTERM')
    expect(await web.exited).toBe(143)
    expect(existsSync(join(home, '.claude', 'web.lock'))).toBe(false)
  }, 30_000)
})
