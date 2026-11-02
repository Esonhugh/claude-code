import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// End-to-end check of a built binary: `claude web` serving the embedded page,
// a real `claude -p` session against a scripted Messages API, driven from
// Chromium. Opt-in because it needs a compiled binary and Playwright:
//   make build && CLAUDE_WEB_BINARY=$PWD/built-claude \
//     bun test src/web/web.binary.test.ts
const binary = process.env.CLAUDE_WEB_BINARY
// Unique per run, so a shell left over from another run never matches.
const BG_MARK = `BG_TAIL_${process.pid}`

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
  'Inline \\(a^2 + b^2\\) and',
  '\\[',
  '\\int_0^1 x\\,dx',
  '\\]',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>',
  '',
  '[click](javascript:window.__xss=3) [safe](https://example.com)',
].join('\n')

// Two phases with one agent each; the agents answer A_OUT and B_OUT.
const WORKFLOW_SCRIPT = `export const meta = {
  name: "two-phase",
  description: "Two phase test workflow",
  phases: [{ title: "Gather", detail: "collect" }, { title: "Write", detail: "write up" }],
}
phase("Gather")
const a = await agent("WFAGENT_A gather", { label: "gather-a" })
phase("Write")
const b = await agent("WFAGENT_B write", { label: "write-b" })
return { a, b }
`

/** A valid PDF with one line of text on each page. */
function tinyPdf(pages: string[]): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pages.flatMap((text, i) => {
      const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ]
    }),
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const offset = out.length
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

async function tinyDocx(text: string): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe.skipIf(!binary)('claude web (built binary)', () => {
  let api: ReturnType<typeof Bun.serve>
  let web: ReturnType<typeof Bun.spawn>
  let signInUrl = ''
  const promptsSeen: string[] = []
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
        promptsSeen.push(JSON.stringify(body.messages))
        const lastBlocks = typeof last.content === 'string' ? [] : last.content
        let blocks: Record<string, unknown>[] = [
          { type: 'text', text: 'Hello from the fake model' },
        ]
        let stop = 'end_turn'
        const lastText = JSON.stringify(last.content)
        const allText = JSON.stringify(body.messages)
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
        // Teammates see only their own prompt; the lead's history also has MAKE_TEAM.
        const teammate = !allText.includes('MAKE_TEAM')
        if (allText.includes('EDITME') && lastText.includes('toolu_read_edit')) {
          // Edit needs the file read first, so EDITME reads it, then edits it.
          blocks = [
            {
              type: 'tool_use',
              id: 'toolu_edit',
              name: 'Edit',
              input: { file_path: join(workspace, 'edit.txt'), old_string: 'beta', new_string: 'gamma' },
            },
          ]
          stop = 'tool_use'
        } else if (lastText.includes('EDITME')) {
          blocks = [{ type: 'tool_use', id: 'toolu_read_edit', name: 'Read', input: { file_path: join(workspace, 'edit.txt') } }]
          stop = 'tool_use'
        } else if (lastText.includes('toolu_task_b')) {
          // Plan with the task tools: finish the first task, start the second.
          const ids = [...lastText.matchAll(/Task #(\d+) created/g)].map(m => m[1])
          blocks = [
            { type: 'tool_use', id: 'toolu_task_c', name: 'TaskUpdate', input: { taskId: ids[0], status: 'completed' } },
            { type: 'tool_use', id: 'toolu_task_d', name: 'TaskUpdate', input: { taskId: ids[1], status: 'in_progress' } },
          ]
          stop = 'tool_use'
        } else if (lastText.includes('TODOS')) {
          blocks = [
            { type: 'tool_use', id: 'toolu_task_a', name: 'TaskCreate', input: { subject: 'Read the code', description: 'Read it', activeForm: 'Reading the code' } },
            { type: 'tool_use', id: 'toolu_task_b', name: 'TaskCreate', input: { subject: 'Write tests', description: 'Write them', activeForm: 'Writing tests' } },
          ]
          stop = 'tool_use'
        } else if (lastText.includes('MEMBER_PING')) {
          blocks = [{ type: 'text', text: 'MEMBER_PONG' }]
        } else if (teammate && allText.includes('TEAM_ALICE')) {
          blocks = [{ type: 'text', text: 'ALICE_DONE' }]
        } else if (teammate && allText.includes('TEAM_BOB')) {
          blocks = [{ type: 'text', text: 'BOB_DONE' }]
        } else if (lastText.includes('teammate-message')) {
          blocks = [{ type: 'text', text: 'LEAD_SAW_MEMBER' }]
        } else if (lastText.includes('WFAGENT_A')) {
          blocks = [{ type: 'text', text: 'A_OUT' }]
        } else if (lastText.includes('WFAGENT_B')) {
          blocks = [{ type: 'text', text: 'B_OUT' }]
        } else if (lastText.includes('RUN_WF')) {
          blocks = [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: WORKFLOW_SCRIPT } }]
          stop = 'tool_use'
        } else if (lastText.includes('MAKE_TEAM')) {
          // A named Agent call joins the session's team (Agent Teams on).
          blocks = [
            { type: 'tool_use', id: 'toolu_alice', name: 'Agent', input: { name: 'alice', description: 'Review methods', prompt: 'TEAM_ALICE review methods' } },
            { type: 'tool_use', id: 'toolu_bob', name: 'Agent', input: { name: 'bob', description: 'Review results', prompt: 'TEAM_BOB review results' } },
          ]
          stop = 'tool_use'
        } else if (lastText.includes('FOLLOWUP_MSG')) {
          blocks = [{ type: 'text', text: 'FOLLOWUP_DONE' }]
        } else if (lastText.includes('SUBTASK_BG')) {
          blocks = [{ type: 'text', text: 'SUB_RESULT' }]
        } else if (lastText.includes('SPAWNBG')) {
          blocks = [
            {
              type: 'tool_use',
              id: 'toolu_agent_bg',
              name: 'Agent',
              input: {
                description: 'Look around',
                prompt: 'SUBTASK_BG please look around',
                subagent_type: 'general-purpose',
                run_in_background: true,
              },
            },
          ]
          stop = 'tool_use'
        } else if (/PREVIEW_URLS ([^"\\\s]+) ([^"\\\s]+)/.test(lastText)) {
          const [, dev, own] = /PREVIEW_URLS ([^"\\\s]+) ([^"\\\s]+)/.exec(lastText)!
          blocks = [{ type: 'text', text: `Dev server: ${dev} and this UI: ${own}` }]
        } else if (lastBlocks.some(b => b.type === 'tool_result')) {
          blocks = [{ type: 'text', text: 'WEB_DONE' }]
        } else if (lastText.includes('OPEN_TERMINAL')) {
          // A colored line, then cat echoes whatever is typed.
          blocks = [{
            type: 'tool_use',
            id: 'toolu_terminal',
            name: 'Terminal',
            input: {
              action: 'new-session',
              command: 'bash',
              args: ['--norc', '--noprofile', '-c', "printf '\\033[31mRED_MARK\\033[0m ready\\n'; exec cat"],
              cols: 80,
              rows: 12,
            },
          }]
          stop = 'tool_use'
        } else if (lastText.includes('BG_SHELL')) {
          blocks = [{
            type: 'tool_use',
            id: 'toolu_bg_shell',
            name: 'Bash',
            input: { command: `echo ${BG_MARK}; sleep 300`, description: 'Background sleep', run_in_background: true },
          }]
          stop = 'tool_use'
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
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
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
      await page.locator('.wl-hi').waitFor()

      const input = page.getByLabel('Message', { exact: true })
      await input.fill('hi there')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      await page.getByText('Claude (Opus 5.5)').first().waitFor()

      await input.fill('please TOUCH a file')
      await input.press('Enter')
      const dialog = page.getByRole('dialog')
      await dialog.getByText('Claude wants to run a command').waitFor({ timeout: 30_000 })
      expect(await dialog.textContent()).toContain('touch made.txt')
      await dialog.getByRole('option', { name: /Allow once/ }).click()
      await page.getByText('WEB_DONE').waitFor({ timeout: 30_000 })
      expect(existsSync(join(workspace, 'made.txt'))).toBe(true)

      await input.fill('please DENYME')
      await input.press('Enter')
      await dialog.getByText('Claude wants to run a command').waitFor({ timeout: 30_000 })
      await dialog.getByRole('option', { name: /Deny and tell Claude/ }).click()
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
      await page.locator('.katex').nth(2).waitFor({ timeout: 30_000 })
      expect(await page.locator('.markdown').last().textContent()).not.toContain('\\(')
      await page.locator('.mermaid svg').waitFor({ timeout: 30_000 })
      expect(await page.locator('a[href^="javascript"]').count()).toBe(0)
      expect(await page.locator('a[href="https://example.com"]').count()).toBe(1)
      expect(await page.getByText('<script>window.__xss=2</script>', { exact: false }).count()).toBe(1)
      expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()
      expect(dialogs).toEqual([])

      await page.locator('.footbtn.perm').click()
      await page.getByRole('menuitemradio', { name: /accept edits on/ }).click()
      await page.waitForFunction(
        () => document.querySelector('.footbtn.perm')?.getAttribute('data-mode') === 'acceptEdits',
      )
      expect(await page.getByLabel('Model').count()).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 90_000)

  it('lists, reopens, renames, stops and resumes sessions', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)

      // The chat from the previous test is listed under the workspace group.
      const row = page.locator('.session-row', { hasText: 'hi there' })
      await row.waitFor({ timeout: 15_000 })
      expect(await page.locator('.proj-t small').first().textContent()).toBe('~/workspace')
      await row.locator('.session-title').click()
      await page.locator('.feed').getByText('Hello from the fake model').waitFor()
      await page.getByText('show MARKDOWN').waitFor()
      // Still running with no tab attached, so this tab picks it up.
      await page.locator('.status-live').waitFor({ timeout: 15_000 })

      // The listing may retitle the row once the transcript has a summary.
      const active = page.locator('.session-row[aria-current="true"]')
      await active.getByRole('button', { name: 'Stop session' }).click()
      await page.locator('.status-readonly').waitFor({ timeout: 15_000 })
      await page.waitForFunction(() => !document.querySelector('.session-row .live'))

      await active.getByRole('button', { name: 'Rename' }).click()
      const rename = page.locator('input.rename')
      await rename.fill('Renamed chat')
      await rename.press('Enter')
      await page.locator('.session-row', { hasText: 'Renamed chat' }).waitFor()

      // Typing resumes the transcript in its own folder with its history.
      const before = promptsSeen.length
      const input = page.getByLabel('Message', { exact: true })
      await input.click()
      await page.locator('.status-live').waitFor({ timeout: 30_000 })
      await input.fill('hello again')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').nth(1).waitFor({ timeout: 30_000 })
      const resumedPrompt = promptsSeen.slice(before).at(-1) ?? ''
      expect(resumedPrompt).toContain('hi there')
      expect(resumedPrompt).toContain('hello again')

      await page.reload()
      await page.locator('.session-row', { hasText: 'Renamed chat' }).waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: '+ New session' }).click()
      await page.locator('.wl-hi').waitFor()
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('attaches files and previews documents by type', async () => {
    const samples = join(workspace, 'samples')
    mkdirSync(samples)
    const sample = (name: string, body: string | Uint8Array) => {
      writeFileSync(join(samples, name), body)
      return join(samples, name)
    }
    const { default: ExcelJS } = await import('exceljs')
    const book = new ExcelJS.Workbook()
    book.addWorksheet('First').addRows([['col1', 'col2'], ['a', 1]])
    book.addWorksheet('Second').addRows([['SECOND_SHEET_CELL']])
    const files = [
      sample('readme.md', '## MD_HEADING\n\ntext'),
      sample('table.csv', 'col1,col2\n"x, y",2\n'),
      sample('page.html', '<h1>HTML_BODY</h1><script>parent.__xss=4</script>'),
      sample('chart.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>parent.__xss=5</script><rect width="10" height="10"/></svg>'),
      sample('book.xlsx', new Uint8Array(await book.xlsx.writeBuffer())),
      sample('letter.docx', await tinyDocx('DOCX_BODY')),
      sample('slides.pdf', tinyPdf(['PAGE_ONE', 'PAGE_TWO'])),
      sample('memo.rtf', '{\\rtf1\\ansi RTF_BODY\\par}'),
    ]
    const notes = join(home, 'notes.txt')
    writeFileSync(notes, 'NOTES_BODY')
    const pixel = join(home, 'pixel.png')
    writeFileSync(
      pixel,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )

    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()

      await page.getByLabel('Upload file').setInputFiles([notes, pixel])
      await page.locator('.attachment', { hasText: 'notes.txt' }).waitFor()
      const before = promptsSeen.length
      const input = page.getByLabel('Message', { exact: true })
      await input.fill(`FILES ${files.map(f => `@${f}`).join(' ')}`)
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      const prompt = promptsSeen.slice(before).join('\n')
      expect(prompt).toContain('"type":"image"')
      expect(prompt).toContain('NOTES_BODY')
      expect(await page.locator('.attachment').count()).toBe(0)
      await page.locator('.bubble-image').waitFor()

      const preview = page.locator('.preview')
      const open = async (name: string) => {
        await page.locator('.file-chip', { hasText: name }).click()
        await preview.locator('.preview-name', { hasText: name }).waitFor()
      }
      await open('notes.txt')
      await preview.getByText('NOTES_BODY').waitFor()
      await open('readme.md')
      await preview.locator('.markdown h3', { hasText: 'MD_HEADING' }).waitFor()
      await open('table.csv')
      await preview.locator('.sheet td', { hasText: 'x, y' }).waitFor()
      await open('page.html')
      const frame = preview.locator('iframe.preview-frame')
      await frame.waitFor()
      expect(await frame.getAttribute('sandbox')).toBe('')
      await page.frameLocator('iframe.preview-frame').getByText('HTML_BODY').waitFor()
      await open('chart.svg')
      await preview.locator('img[src^="blob:"]').waitFor()
      await open('book.xlsx')
      await preview.getByRole('tab', { name: 'Second' }).click()
      await preview.getByText('SECOND_SHEET_CELL').waitFor({ timeout: 30_000 })
      await open('letter.docx')
      await preview.locator('.docx-page', { hasText: 'DOCX_BODY' }).waitFor({ timeout: 30_000 })
      await open('slides.pdf')
      await preview.locator('.page-count', { hasText: '/ 2' }).waitFor({ timeout: 30_000 })
      await preview.getByRole('button', { name: 'Next page' }).click()
      await page.waitForFunction(
        () => (document.querySelector('.pager input') as HTMLInputElement | null)?.value === '2',
      )
      await open('memo.rtf')
      if (Bun.which('soffice')) {
        await preview.locator('.page-count', { hasText: '/ 1' }).waitFor({ timeout: 120_000 })
      } else {
        await preview.getByText('LibreOffice').waitFor({ timeout: 30_000 })
      }
      await page.keyboard.press('Escape')
      await preview.waitFor({ state: 'detached' })
      expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()

      const statuses = await page.evaluate(async (paths: string[]) => {
        const sessions = (await (await fetch('/api/sessions')).json()) as { id: string }[]
        const id = sessions.at(-1)!.id
        return Promise.all(
          paths.map(async p => (await fetch(`/api/files/${id}?path=${encodeURIComponent(p)}`)).status),
        )
      }, ['/etc/passwd', join(home, '.claude', 'web.lock'), `${samples}/../../notes.txt`])
      expect(statuses).toEqual([404, 404, 404])
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('shows background agents in the panel and messages a finished one', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })
      await input.fill('please SPAWNBG an agent')
      await input.press('Enter')

      // The Agent card links to its task; the panel lists it.
      const chip = page.locator('.agent-chip')
      await chip.waitFor({ timeout: 30_000 })
      const panel = page.locator('aside.side')
      await panel.getByRole('tab', { name: /^Agents/ }).click()
      // Finished agents fold by default; wait for it to finish, then unfold.
      const finished = panel.getByRole('button', { name: /Ended/ })
      await finished.waitFor({ timeout: 60_000 })
      if ((await finished.getAttribute('aria-expanded')) === 'false') await finished.click()
      await panel.locator('.agent-row', { hasText: 'Look around' }).click()
      await panel.locator('.agent-feed').getByText('SUB_RESULT').first().waitFor({ timeout: 30_000 })

      const agentInput = panel.getByPlaceholder('Message general-purpose')
      await agentInput.fill('FOLLOWUP_MSG now')
      await agentInput.press('Enter')
      await panel.getByText('The agent resumed with your message.').waitFor({ timeout: 30_000 })
      await panel.getByText('FOLLOWUP_DONE').waitFor({ timeout: 60_000 })

      // Back to the tree, then away to another tab.
      await panel.getByRole('button', { name: 'Back' }).click()
      await panel.getByText('Main session').waitFor()
      await panel.getByRole('tab', { name: 'Status' }).click()
      await panel.locator('.agent-row').first().waitFor({ state: 'detached' })
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 180_000)

  it('completes slash commands from the palette and runs them', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })
      await input.fill('hi palette')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })

      const palette = page.getByRole('listbox', { name: 'Completions' })
      await input.fill('/')
      await palette.waitFor()
      expect(await palette.getByRole('option').count()).toBeGreaterThan(5)
      await input.press('Escape')
      await palette.waitFor({ state: 'detached' })

      // Terminal-only commands (from system/init) are not offered.
      await input.fill('/col')
      await page.waitForTimeout(200)
      expect(await palette.getByRole('option', { name: /^\/color/ }).count()).toBe(0)

      // `cost` is an alias of `usage`, a local command: no model call.
      await input.fill('/cos')
      const usage = palette.getByRole('option', { name: /^\/usage/ })
      await usage.waitFor()
      expect(await usage.textContent()).toContain('cost')
      await input.press('Enter')
      expect(await input.inputValue()).toBe('/usage ')
      await palette.waitFor({ state: 'detached' })
      const before = promptsSeen.length
      await input.press('Enter')
      await page.getByText('Total cost:').waitFor({ timeout: 30_000 })
      expect(promptsSeen.length).toBe(before)

      // Mouse: click a row to complete it.
      await input.fill('/cont')
      await palette.getByRole('option', { name: /^\/context/ }).click()
      expect(await input.inputValue()).toBe('/context ')
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('shows a workflow and a team, messages a teammate and restores the panel after a reload', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })
      await input.fill('please RUN_WF now')
      await input.press('Enter')

      // The Workflow tool may ask first.
      const dialog = page.getByRole('dialog')
      await page.locator('.agent-chip').or(dialog).first().waitFor({ timeout: 30_000 })
      if (await dialog.isVisible()) {
        await dialog.getByRole('option', { name: /Allow once/ }).click()
      }
      await page.locator('.agent-chip').waitFor({ timeout: 30_000 })
      const panel = page.locator('aside.side')
      const agentsTab = panel.getByRole('tab', { name: /^Agents/ })
      await agentsTab.click()

      // Both phases ran; the workflow agents sit in its lanes, not in the tree.
      const finished = panel.getByRole('button', { name: /Ended/ })
      await finished.waitFor({ timeout: 60_000 })
      if ((await finished.getAttribute('aria-expanded')) === 'false') await finished.click()
      await panel.locator('.agent-row', { hasText: 'two-phase' }).first().click()
      await panel.getByText('Phase 2/2 · Write').waitFor({ timeout: 30_000 })
      await panel.getByRole('button', { name: 'Expand' }).click()
      const lanes = page.locator('.lanes')
      await lanes.locator('.lane h3', { hasText: 'Gather' }).waitFor()
      await lanes.locator('.lane h3', { hasText: 'Write' }).waitFor()
      expect(await lanes.locator('.wcard b').allTextContents()).toEqual(['gather-a', 'write-b'])
      await lanes.locator('.wcard', { hasText: 'write-b' }).click()
      await panel.getByText('B_OUT').waitFor({ timeout: 30_000 })
      await panel.getByText('Workflow agents are read-only.').waitFor()
      await agentsTab.click()

      await input.fill('please MAKE_TEAM now')
      await input.press('Enter')
      const team = panel.locator('.team-section', { hasText: 'Team' })
      await team.locator('.agent-row', { hasText: 'alice' }).waitFor({ timeout: 30_000 })
      await team.locator('.agent-row', { hasText: 'bob' }).waitFor()
      // Both report idle to the lead, which sees it as a teammate message.
      await team.getByText('0 working · 2 idle').waitFor({ timeout: 60_000 })
      await page.locator('.msg.teammate', { hasText: 'alice' }).first().waitFor()
      await page.getByText('LEAD_SAW_MEMBER').first().waitFor({ timeout: 30_000 })
      await team.locator('.agent-row', { hasText: 'Messages' }).click()
      await panel.locator('.team-timeline li', { hasText: 'ALICE_DONE' }).waitFor()
      await panel.getByRole('button', { name: 'Back' }).click()

      // A message to a running teammate goes straight into its conversation.
      await team.locator('.agent-row', { hasText: 'alice' }).click()
      const memberInput = panel.getByPlaceholder('Message alice')
      await memberInput.fill('MEMBER_PING hi')
      await memberInput.press('Enter')
      await panel.getByText('Sent to the teammate.').waitFor({ timeout: 30_000 })
      await panel.getByText('MEMBER_PONG').waitFor({ timeout: 60_000 })
      await panel.getByRole('button', { name: 'Back' }).click()

      // The team outlives the turn: another prompt, and nobody has stopped.
      await input.fill('hello after the team')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').last().waitFor({ timeout: 30_000 })
      expect(await team.locator('.member-stopped').count()).toBe(0)

      // A reload rebuilds the panel from what the server replays.
      await page.reload()
      await page.locator('.session-row', { hasText: 'RUN_WF' }).locator('.session-title').click()
      await page.locator('.status-live').waitFor({ timeout: 30_000 })
      await agentsTab.click()
      await team.locator('.agent-row', { hasText: 'alice' }).waitFor({ timeout: 30_000 })
      await team.locator('.agent-row', { hasText: 'bob' }).waitFor()
      if ((await finished.getAttribute('aria-expanded')) === 'false') await finished.click()
      await panel.locator('.agent-row', { hasText: 'two-phase' }).first().waitFor()
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('fits a phone screen with drawers for both side panels', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    // Optional: CLAUDE_WEB_SCREENS=<dir> saves screenshots along the way.
    const screens = process.env.CLAUDE_WEB_SCREENS
    const shot = async (page: { screenshot(o: { path: string }): Promise<unknown> }, name: string) => {
      if (screens) await page.screenshot({ path: join(screens, `${name}.png`) })
    }
    try {
      const context = await browser.newContext({
        locale: 'en-US',
        viewport: { width: 375, height: 740 },
        hasTouch: true,
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      const noSideScroll = () =>
        page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)
      const visibility = (selector: string) =>
        page.evaluate(
          (s: string) => getComputedStyle(document.querySelector(s)!).visibility,
          selector,
        )
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      expect(await noSideScroll()).toBe(true)

      // The history sidebar is an off-canvas drawer: Esc closes it and hands
      // focus back to the menu button.
      const menu = page.getByRole('button', { name: 'Open sessions' })
      expect(await visibility('.sessions')).toBe('hidden')
      await menu.click()
      expect(await menu.getAttribute('aria-expanded')).toBe('true')
      await page.waitForFunction(() => document.activeElement?.classList.contains('new-chat'))
      await page.waitForTimeout(300)
      await shot(page, 'phone-light-sidebar')
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.sessions')!).visibility === 'hidden',
      )
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        'Open sessions',
      )

      const input = page.getByLabel('Message', { exact: true })
      await input.fill('hi from a phone')
      await page.getByRole('button', { name: 'Start' }).click()
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      expect(await noSideScroll()).toBe(true)
      for (const box of await page
        .locator('.meta button, .composer button')
        .evaluateAll((els: Element[]) => els.map(el => el.getBoundingClientRect().toJSON()))) {
        expect(box.height).toBeGreaterThanOrEqual(40)
        expect(box.right).toBeLessThanOrEqual(375)
      }
      await shot(page, 'phone-light-chat')

      // Tapping the backdrop closes the sidebar drawer...
      await menu.click()
      await page.waitForTimeout(300)
      await page.mouse.click(360, 400)
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.sessions')!).visibility === 'hidden',
      )

      // ...and the right panel, a bottom sheet that also takes focus while it is open.
      const agents = page.getByRole('button', { name: 'Open panel' })
      expect(await visibility('.side')).toBe('hidden')
      await agents.click()
      const panel = page.locator('aside.side')
      await panel.getByRole('tab', { name: /^Agents/ }).click()
      await page.waitForFunction(() => !!document.activeElement?.closest('aside.side'))
      await page.waitForTimeout(300)
      const box = await panel.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.y).toBeGreaterThan(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(375)
      await page.emulateMedia({ colorScheme: 'dark' })
      await shot(page, 'phone-dark-agents')
      await page.mouse.click(187, 20)
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.side')!).visibility === 'hidden',
      )
      expect(await agents.evaluate((el: Element) => el === document.activeElement)).toBe(true)
      await shot(page, 'phone-dark-chat')
      expect(await noSideScroll()).toBe(true)

      await page.setViewportSize({ width: 1280, height: 800 })
      await shot(page, 'desktop-dark-chat')
      await page.emulateMedia({ colorScheme: 'light' })
      await shot(page, 'desktop-light-chat')
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('previews a loopback dev server in a frame but never the UI itself', async () => {
    const dev = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response('<h1>DEV_SERVER_MARKER</h1>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    })
    const devUrl = `http://127.0.0.1:${dev.port}/`
    const uiOrigin = new URL(signInUrl).origin
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })
      await input.fill(`PREVIEW_URLS ${devUrl} ${uiOrigin}/api/info`)
      await input.press('Enter')
      const reply = page.locator('.msg.assistant .markdown', { hasText: 'Dev server:' })
      await reply.waitFor({ timeout: 30_000 })
      // Only the dev server gets a Preview button; the UI's own /api does not.
      await reply.locator('.link-preview').first().waitFor()
      expect(await reply.locator('.link-preview').count()).toBe(1)
      expect(await reply.locator('.link-preview').getAttribute('title')).toBe(devUrl)
      await reply.locator('.link-preview').click()

      const frame = page.locator('iframe.web-preview-frame')
      await frame.waitFor()
      expect(await frame.getAttribute('sandbox')).toBe(
        'allow-scripts allow-forms allow-popups allow-same-origin',
      )
      expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer')
      await page.frameLocator('iframe.web-preview-frame').getByText('DEV_SERVER_MARKER').waitFor({ timeout: 15_000 })
      expect(await page.locator('.preview .preview-name').textContent()).toBe(devUrl)
      expect(await page.locator('.preview a', { hasText: 'New tab' }).getAttribute('href')).toBe(devUrl)
      await page.locator('.preview').getByRole('button', { name: 'Refresh' }).click()
      await page.frameLocator('iframe.web-preview-frame').getByText('DEV_SERVER_MARKER').waitFor({ timeout: 15_000 })
      await page.locator('.preview').getByRole('button', { name: 'Close' }).click()
      await frame.waitFor({ state: 'detached' })
      expect(errors).toEqual([])
    } finally {
      await browser.close()
      dev.stop(true)
    }
  }, 90_000)

  it('shows edit diffs, approval results, the context popover, todo pins and @ completion', async () => {
    writeFileSync(join(workspace, 'edit.txt'), 'alpha\nbeta\n')
    writeFileSync(join(workspace, 'README.md'), '# workspace\n')
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"]).stdout.toString().trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US' })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.sessions .new-chat').click()
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })

      await input.fill('please EDITME')
      await input.press('Enter')
      const dialog = page.locator('.askdock')
      await dialog.getByText('Claude wants to use Edit').waitFor({ timeout: 30_000 })
      await dialog.getByRole('option', { name: /Allow once/ }).click()
      await page.getByText('WEB_DONE').waitFor({ timeout: 30_000 })
      expect(readFileSync(join(workspace, 'edit.txt'), 'utf8')).toBe('alpha\ngamma\n')
      // The answer stays where the request was, and the card shows the diff.
      expect(await page.locator('.ask-ref.done').textContent()).toBe('Allowed once')
      const card = page.locator('.toolcard', { has: page.locator('.tname', { hasText: 'Edit' }) })
      expect(await card.locator('.tcmd').textContent()).toBe('edit.txt')
      expect(await card.locator('.dl.del span').textContent()).toBe('beta')
      expect(await card.locator('.dl.add span').textContent()).toBe('gamma')
      expect(await card.locator('.dstat').allTextContents()).toEqual(['+1', '−1'])
      expect(await card.locator('.tfoot').textContent()).toContain('~/workspace/edit.txt')
      // No separate preview button: the path itself opens the file.
      expect(await card.locator('.tool-preview').count()).toBe(0)
      await card.locator('.tcmd').click()
      const preview = page.locator('.preview')
      await preview.locator('.preview-name', { hasText: 'edit.txt' }).waitFor()
      await preview.getByText('gamma').waitFor()
      await page.keyboard.press('Escape')
      await preview.waitFor({ state: 'detached' })

      // The context chip opens its breakdown.
      await page.locator('#ctx-chip').click()
      const pop = page.locator('#ctxpop')
      await pop.getByRole('button', { name: '/compact now' }).waitFor()
      await pop.locator('.ctxlegend').waitFor({ timeout: 15_000 })
      expect(await pop.locator('.ctxmeter i').count()).toBe(3)
      expect(await pop.textContent()).toMatch(/Context \d+% · [\d.]+k? \/ \d+[kM]/)
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })

      await input.fill('TODOS please')
      await input.press('Enter')
      const pin = page.locator('.pins .pin')
      // The pin appears with the tasks and fills in as they are updated.
      await pin.locator('b', { hasText: 'Todos 1/2' }).waitFor({ timeout: 30_000 })
      expect(await pin.locator('.ptxt').textContent()).toBe('Writing tests')
      await pin.locator('button').click()
      expect(await pin.locator('.todo-i.completed').textContent()).toContain('Read the code')
      await page.getByText('WEB_DONE').nth(1).waitFor({ timeout: 30_000 })

      // @ lists workspace files; Enter puts the mention in the box.
      // Keep the pointer off the palette so hovering does not move the selection.
      await page.mouse.move(0, 0)
      await input.fill('look at @READ')
      const option = page.getByRole('option', { name: /@README\.md/ })
      await option.waitFor({ timeout: 10_000 })
      await input.press('Enter')
      expect(await input.inputValue()).toBe('look at @README.md ')

      // ↑ on an empty box brings back the previous prompt.
      await input.fill('')
      await input.press('ArrowUp')
      expect(await input.inputValue()).toBe('TODOS please')
      await input.press('ArrowUp')
      expect(await input.inputValue()).toBe('please EDITME')
      await input.press('ArrowDown')
      await input.press('ArrowDown')
      expect(await input.inputValue()).toBe('')
      expect(errors).toEqual([])
      // Stay under the server's session limit for the tests after this one.
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('shows a colored terminal screen, types into it and stops a background shell', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })
      const dialog = page.getByRole('dialog')

      await input.fill('please OPEN_TERMINAL')
      await input.press('Enter')
      await dialog.getByRole('option', { name: /Allow once/ }).click()
      await page.getByText('WEB_DONE').waitFor({ timeout: 30_000 })
      const panel = page.locator('aside.side')
      await panel.getByRole('tab', { name: /^Terminals/ }).click()
      const row = panel.locator('.tree .node', { hasText: 'bash --norc' })
      await row.waitFor({ timeout: 15_000 })
      expect(await row.locator('.badge').textContent()).toBe('running')
      expect(await row.locator('.meta2').textContent()).toBe('Main session opened · 80×12')
      // The server sends styled spans; the page only maps them to classes.
      const screen = panel.getByLabel('Terminal screen')
      await screen.locator('.f31', { hasText: 'RED_MARK' }).waitFor({ timeout: 15_000 })
      expect(await screen.textContent()).toContain('RED_MARK ready')

      const typed = panel.getByLabel('Type into the terminal, Enter to submit')
      await typed.fill('hello-from-web')
      await typed.press('Enter')
      // The tty echoes the line and cat prints it back.
      await page.waitForFunction(
        () => (document.querySelector('.screen')?.textContent ?? '').split('hello-from-web').length === 3,
        undefined,
        { timeout: 15_000 },
      )
      await panel.getByRole('button', { name: 'Stop', exact: true }).click()
      await row.locator('.badge.killed').waitFor({ timeout: 15_000 })
      await typed.waitFor({ state: 'detached' })

      await input.fill('please BG_SHELL')
      await input.press('Enter')
      // echo and sleep are read-only, so this one runs without asking.
      await page.getByText('WEB_DONE').nth(1).waitFor({ timeout: 30_000 })
      const bgTab = panel.getByRole('tab', { name: /^Background Tasks/ })
      await bgTab.click()
      const bgRow = panel.locator('.bgrow', { hasText: `echo ${BG_MARK}; sleep 300` })
      await bgRow.waitFor({ timeout: 15_000 })
      expect(await bgRow.locator('.tag').textContent()).toBe('Bash')
      await bgRow.locator('.meta2', { hasText: BG_MARK }).waitFor({ timeout: 15_000 })
      expect(await bgRow.locator('.meta2').textContent()).toMatch(new RegExp(`^Main session · \\d+s · ${BG_MARK}$`))
      await bgRow.getByRole('button', { name: 'Stop' }).click()
      await bgRow.locator('.badge.killed').or(bgRow.locator('.badge.completed')).waitFor({ timeout: 15_000 })
      await bgRow.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' })
      expect(Bun.spawnSync(['pgrep', '-f', `${BG_MARK}; sleep 300`]).exitCode).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('shuts down on SIGTERM and removes the lock', async () => {
    web.kill('SIGTERM')
    expect(await web.exited).toBe(143)
    expect(existsSync(join(home, '.claude', 'web.lock'))).toBe(false)
  }, 30_000)
})
