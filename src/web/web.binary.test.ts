import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

// End-to-end check of a built binary: `claude web` serving the embedded page,
// a real `claude -p` session against a scripted Messages API, driven from
// Chromium. Opt-in because it needs a compiled binary and Playwright:
//   make build && CLAUDE_WEB_BINARY=$PWD/built-claude \
//     bun test src/web/web.binary.test.ts
const binary = process.env.CLAUDE_WEB_BINARY
// Windows finds the home folder in USERPROFILE and needs SystemRoot to start processes.
// A wait that, on timeout, also reports what the element shows instead.
const showing = async (wait: Promise<unknown>, what: { textContent: () => Promise<string | null> }) => {
  try {
    await wait
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message.split('\n')[0] : e}\nShowing: ${(await what.textContent().catch(() => null))?.slice(-600)}`)
  }
}
const windowsHome = (home: string) =>
  process.platform === 'win32' ? { USERPROFILE: home, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}
// The coordinator's system prompt (src/coordinator/coordinatorMode.ts).
const COORDINATOR_MARK = 'You are a **coordinator**'
// Unique per run, so a shell left over from another run never matches.
const BG_MARK = `BG_TAIL_${process.pid}`

const sse = (blocks: Record<string, unknown>[], stop: string, inputTokens = 1) => {
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
      usage: { input_tokens: inputTokens, output_tokens: 1 },
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
  // Requests whose system prompt is the coordinator's: [system text, messages].
  const coordinatorSeen: [string, string][] = []
  let home = ''
  let workspace = ''
  // The model of each request a resumed Quick task makes.
  const resumedModels: string[] = []
  // The Slow and Hang workers wait on this until the suite ends.
  let releaseWorkers = () => {}
  const workersHeld = new Promise<void>(resolve => (releaseWorkers = resolve))
  // The Long workers wait here on their first request until the test has sent them a message.
  const longGates: Record<string, () => void> = {}
  const longHeld: Record<string, Promise<void>> = {}
  for (const name of ['LONG_A', 'LONG_B', 'SLASH']) longHeld[name] = new Promise<void>(resolve => (longGates[name] = resolve))
  const agent = (description: string, prompt: string) => ({
    type: 'tool_use',
    id: `toolu_${description.toLowerCase()}`,
    name: 'Agent',
    input: { description, prompt, subagent_type: 'worker' },
  })

  const startWeb = async () => {
    web = Bun.spawn(
      // Above the default 8, so a test that fails before closing its sessions does not starve the next ones.
      [binary!, 'web', '--no-open', '--port', '0', '--workspace', workspace, '--max-sessions', '32'],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          ...windowsHome(home),
          IS_SANDBOX: '1',
          ANTHROPIC_API_KEY: 'sk-fake',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
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
  }

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
          model?: string
          system?: string | { text?: string }[]
          messages: { role: string; content: string | Block[] }[]
        }
        const last = body.messages.at(-1)!
        promptsSeen.push(JSON.stringify(body.messages))
        const lastBlocks = typeof last.content === 'string' ? [] : last.content
        let blocks: Record<string, unknown>[] = [
          { type: 'text', text: 'Hello from the fake model' },
        ]
        let stop = 'end_turn'
        let inputTokens = 1
        const lastText = JSON.stringify(last.content)
        const allText = JSON.stringify(body.messages)
        const systemText = typeof body.system === 'string' ? body.system : (body.system ?? []).map(b => b.text ?? '').join('\n')
        const coordinator = systemText.includes(COORDINATOR_MARK)
        if (coordinator) coordinatorSeen.push([systemText, allText])
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
        if (coordinator && lastText.includes('DISPATCH_P3')) {
          blocks = [
            agent('Ask', 'WORKER_ASK create asked.txt'),
            agent('Quick', 'WORKER_QUICK answer quickly'),
            agent('Slow', 'WORKER_SLOW read slow.txt and wait'),
          ]
          stop = 'tool_use'
        } else if (!coordinator && lastText.includes('/e2e-skill go')) {
          // Typed into an agent, a skill reaches it as the text the CLI's agent view sends.
          blocks = [{ type: 'text', text: 'SKILL_REACHED' }]
        } else if (coordinator && lastText.includes('DISPATCH_LONG')) {
          blocks = [agent('LongA', 'WORKER_LONG_A run'), agent('LongB', 'WORKER_LONG_B run')]
          stop = 'tool_use'
        } else if (coordinator && lastText.includes('TELL_LONG_B')) {
          const id = /agentId: ([\w-]+)[^"]*?(?=[\s\S]*WORKER_LONG_B)/.exec(allText)?.[1] ??
            [...allText.matchAll(/agentId: ([\w-]+)/g)].map(m => m[1]).at(-1)
          blocks = [{ type: 'tool_use', id: 'toolu_tell_b', name: 'SendMessage', input: { to: id, summary: 'note for B', message: 'COORD_NOTE for B' } }]
          stop = 'tool_use'
        } else if (!coordinator && /WORKER_LONG_[AB]/.test(allText)) {
          const name = allText.includes('WORKER_LONG_A') ? 'LONG_A' : 'LONG_B'
          if (lastBlocks.some(b => b.type === 'tool_result')) {
            blocks = [{ type: 'text', text: /USER_NOTE|COORD_NOTE/.test(lastText) ? `${name}_SAW_NOTE` : `${name}_OUT` }]
          } else {
            await longHeld[name]
            blocks = [{ type: 'tool_use', id: `toolu_${name.toLowerCase()}_read`, name: 'Read', input: { file_path: join(workspace, 'slow.txt') } }]
            stop = 'tool_use'
          }
        } else if (coordinator && lastText.includes('DISPATCH_SLASH')) {
          blocks = [agent('SlashA', 'WORKER_SLASH run')]
          stop = 'tool_use'
        } else if (!coordinator && allText.includes('WORKER_SLASH')) {
          if (lastBlocks.some(b => b.type === 'tool_result')) {
            blocks = [{ type: 'text', text: 'SLASH_OUT' }]
          } else {
            await longHeld.SLASH
            blocks = [{ type: 'tool_use', id: 'toolu_slash_read', name: 'Read', input: { file_path: join(workspace, 'slow.txt') } }]
            stop = 'tool_use'
          }
        } else if (coordinator && lastText.includes('DISPATCH_MULTI')) {
          blocks = [agent('MultiA', 'WORKER_MULTI_A run'), agent('MultiB', 'WORKER_MULTI_B run')]
          stop = 'tool_use'
        } else if (!coordinator && /WORKER_MULTI_[AB]/.test(allText)) {
          const name = allText.includes('WORKER_MULTI_A') ? 'MULTI_A' : 'MULTI_B'
          blocks = [{ type: 'text', text: lastText.includes('MULTI_NOTE') ? `${name}_SAW_NOTE` : `${name}_OUT` }]
        } else if (coordinator && lastText.includes('TASK_NOTE')) {
          blocks = [{ type: 'text', text: 'COORD_SAW_TASK_NOTE' }]
        } else if (coordinator && lastText.includes('DISPATCH_SKILLCHK')) {
          blocks = [agent('Skillchk', 'WORKER_SKILLCHK say hi')]
          stop = 'tool_use'
        } else if (!coordinator && allText.includes('WORKER_SKILLCHK')) {
          blocks = [{ type: 'text', text: 'SKILLCHK_OUT' }]
        } else if (coordinator && lastText.includes('DISPATCH_HANG')) {
          blocks = [agent('Hang', 'WORKER_HANG wait for the server')]
          stop = 'tool_use'
        } else if (!coordinator && allText.includes('WORKER_ASK')) {
          // Bash outside the allow list: the worker's request reaches the page.
          if (lastText.includes('toolu_ask_bash')) {
            blocks = [{ type: 'text', text: 'ASK_OUT' }]
          } else {
            blocks = [{ type: 'tool_use', id: 'toolu_ask_bash', name: 'Bash', input: { command: 'touch asked.txt', description: 'Create asked file' } }]
            stop = 'tool_use'
          }
        } else if (!coordinator && allText.includes('WORKER_QUICK')) {
          inputTokens = 2400
          if (lastText.includes('QUICK_MORE')) {
            resumedModels.push(body.model ?? '')
            blocks = [{ type: 'text', text: 'QUICK_AGAIN' }]
          } else {
            blocks = [{ type: 'text', text: 'QUICK_OUT' }]
          }
        } else if (!coordinator && allText.includes('WORKER_SLOW')) {
          inputTokens = 3200
          if (lastText.includes('toolu_slow_read')) {
            await workersHeld
            blocks = [{ type: 'text', text: 'SLOW_OUT' }]
          } else {
            blocks = [{ type: 'tool_use', id: 'toolu_slow_read', name: 'Read', input: { file_path: join(workspace, 'slow.txt') } }]
            stop = 'tool_use'
          }
        } else if (!coordinator && allText.includes('WORKER_HANG')) {
          if (lastText.includes('HANG_RESUME')) {
            blocks = [{ type: 'text', text: 'HANG_BACK' }]
          } else {
            await workersHeld
            blocks = [{ type: 'text', text: 'HANG_OUT' }]
          }
        } else if (coordinator && lastText.includes('DISPATCH_TWO')) {
          blocks = [
            { type: 'text', text: 'Dispatching two tasks.' },
            { type: 'tool_use', id: 'toolu_pj_one', name: 'Agent', input: { description: 'Task one', prompt: 'WORKER_ONE do the first part', subagent_type: 'worker' } },
            { type: 'tool_use', id: 'toolu_pj_two', name: 'Agent', input: { description: 'Task two', prompt: 'WORKER_TWO do the second part', subagent_type: 'worker' } },
          ]
          stop = 'tool_use'
        } else if (coordinator && lastText.includes('task-notification')) {
          blocks = [{ type: 'text', text: 'COORD_SAW_RESULT' }]
        } else if (coordinator && lastBlocks.some(b => b.type === 'tool_result')) {
          blocks = [{ type: 'text', text: 'COORD_LAUNCHED' }]
        } else if (coordinator && lastText.includes('AFTER_RESUME')) {
          blocks = [{ type: 'text', text: 'COORD_RESUMED' }]
        } else if (coordinator && lastText.includes('AFTER_RESTART')) {
          blocks = [{ type: 'text', text: 'COORD_RESTARTED' }]
        } else if (!coordinator && lastText.includes('WORKER_ONE')) {
          blocks = [{ type: 'text', text: 'ONE_OUT' }]
        } else if (!coordinator && lastText.includes('WORKER_TWO')) {
          blocks = [{ type: 'text', text: 'TWO_OUT' }]
        } else if (allText.includes('EDITME') && lastText.includes('toolu_read_edit')) {
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
        } else if (lastText.includes('HOLD_TURN')) {
          // A long turn that only an interrupt ends early.
          await new Promise(r => setTimeout(r, 25_000))
          blocks = [{ type: 'text', text: 'HELD_DONE' }]
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
        } else if (lastText.includes('OPEN_TERMINAL_TWO')) {
          blocks = [{
            type: 'tool_use',
            id: 'toolu_terminal_two',
            name: 'Terminal',
            input: {
              action: 'new-session',
              command: 'bash',
              args: ['--norc', '--noprofile', '-c', "printf 'SECOND_MARK\\n'; exec cat"],
              cols: 80,
              rows: 12,
            },
          }]
          stop = 'tool_use'
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
        return new Response(sse(blocks, stop, inputTokens), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })

    // .native expands Windows 8.3 names (RUNNER~1), which the CLI's own paths never use.
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'web-bin-home-')))
    workspace = join(home, 'workspace')
    mkdirSync(workspace)
    // A user skill and user CLAUDE.md for the Skills and Memory dialogs.
    mkdirSync(join(home, '.claude', 'skills', 'e2e-skill'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'skills', 'e2e-skill', 'SKILL.md'),
      '---\nname: e2e-skill\ndescription: E2E sample skill\n---\n\nE2E_SKILL_BODY\n',
    )
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Notes\n\nE2E_MEMORY_MARKER\n')
    await startWeb()
  }, 30_000)

  afterAll(() => {
    releaseWorkers()
    for (const release of Object.values(longGates)) release()
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

      // The chat from the previous test is listed under the workspace group, named by its last prompt.
      const row = page.locator('.session-row', { hasText: 'show MARKDOWN' })
      await row.waitFor({ timeout: 15_000 })
      expect(await page.locator('.proj-t b').first().textContent()).toBe('workspace')
      await row.locator('.session-title').click()
      await page.locator('.feed').getByText('Hello from the fake model').waitFor()
      await page.locator('.feed').getByText('show MARKDOWN').waitFor()
      // Still running with no tab attached, so this tab picks it up.
      await page.locator('.status-live').waitFor({ timeout: 15_000 })

      // The listing may retitle the row once the transcript has a summary.
      const active = page.locator('.session-row[aria-current="true"]')
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
      await page.locator('.status-readonly').waitFor({ timeout: 15_000 })
      await page.waitForFunction(() => !document.querySelector('.session-row .live'))

      await active.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Rename/ }).click()
      const rename = page.locator('input.ren')
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

  it('pins, renames, marks unread, orders folders by activity, shows the hover card and deletes', async () => {
    // Two older sessions in another folder, written as transcripts on disk.
    const other = join(home, 'other')
    mkdirSync(other, { recursive: true })
    const projectDir = join(home, '.claude', 'projects', other.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    const seed = (id: string, title: string) => {
      const file = join(projectDir, `${id}.jsonl`)
      const at = new Date(Date.now() - 3 * 864e5)
      const base = { sessionId: id, cwd: other, timestamp: at.toISOString(), isSidechain: false }
      writeFileSync(
        file,
        [
          { ...base, type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: title } },
          { type: 'custom-title', sessionId: id, customTitle: title },
        ]
          .map(l => JSON.stringify(l))
          .join('\n') + '\n',
      )
      utimesSync(file, at, at)
      return file
    }
    const keepId = 'aaaaaaaa-1111-4222-8333-444444444444'
    const dropId = 'bbbbbbbb-1111-4222-8333-444444444444'
    seed(keepId, 'Old note')
    const dropFile = seed(dropId, 'Delete me')

    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"]).stdout.toString().trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
      const row = (title: string) => page.locator('#sessions .history .sess', { hasText: title })
      const folders = () => page.locator('.proj-t b').allTextContents()
      const sections = () => page.locator('.sb-h > button:first-child').allTextContents()
      await row('Old note').waitFor({ timeout: 15_000 })
      expect((await folders()).slice(0, 2)).toEqual(['workspace', 'other'])

      // Pin from the row's hover button; it survives a reload.
      await row('Old note').hover()
      await row('Old note').locator('..').getByRole('button', { name: 'Pin' }).click()
      await page.locator('.sb-sec').first().getByText('Old note').waitFor()
      await page.reload()
      await row('Old note').first().waitFor({ timeout: 15_000 })
      expect((await sections())[0]).toContain('Pinned')
      expect(await page.locator('.sb-sec').first().locator('.sess').allTextContents()).toEqual(['Old note'])

      // Rename from the right-click menu (R), inline.
      await row('Old note').click({ button: 'right' })
      await page.locator('.ctxmenu').waitFor()
      await page.keyboard.press('r')
      const input = page.locator('input.ren')
      await input.fill('Kept note')
      await input.press('Enter')
      await row('Kept note').waitFor()
      await page.reload()
      await row('Kept note').waitFor({ timeout: 15_000 })
      expect(await row('Old note').count()).toBe(0)

      // Esc closes the menu; U marks unread: bold title and a blue dot.
      await row('Kept note').click({ button: 'right' })
      await page.keyboard.press('Escape')
      await page.locator('.ctxmenu').waitFor({ state: 'detached' })
      await row('Kept note').click({ button: 'right' })
      await page.keyboard.press('u')
      await page.locator('.sess.unread', { hasText: 'Kept note' }).locator('.ud').waitFor()
      await page.reload()
      await page.locator('.sess.unread', { hasText: 'Kept note' }).waitFor({ timeout: 15_000 })

      // The hover card: fields that are known, the pointer can rest on it and its text can be selected.
      await page.mouse.move(800, 400)
      await row('Delete me').hover()
      const card = page.locator('.sbtip')
      await card.waitFor()
      expect(await card.textContent()).toContain(`Folder ~${sep}other`)
      expect(await card.textContent()).toContain(`ID ${dropId}`)
      expect(await card.textContent()).not.toContain('Changes')
      const id = card.locator('i.mono')
      await id.hover()
      await page.waitForTimeout(500)
      expect(await card.isVisible()).toBe(true)
      await id.click({ clickCount: 3 })
      expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(dropId)
      // The selection copies to the real clipboard.
      await page.keyboard.press('ControlOrMeta+c')
      expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(dropId)

      // Opening an unread session marks it read and closes the card.
      await row('Kept note').click()
      await card.waitFor({ state: 'detached' })
      await page.waitForFunction(() => !document.querySelector('.sess.unread'))

      // Activity in the other folder moves it to the top.
      const message = page.getByLabel('Message', { exact: true })
      await message.click()
      await page.locator('.status-live').waitFor({ timeout: 30_000 })
      await message.fill('hello from other')
      await message.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      await page.waitForFunction(() => document.querySelector('.proj-t b')?.textContent === 'other', null, { timeout: 15_000 })
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })

      // Rows take the right click; text fields keep the browser's own menu.
      await page.evaluate(() =>
        addEventListener('contextmenu', e => document.body.setAttribute('data-cm', String(e.defaultPrevented))),
      )
      const search = page.getByLabel('Search sessions', { exact: true })
      await search.click({ button: 'right' })
      expect(await page.locator('body').getAttribute('data-cm')).toBe('false')
      expect(await page.locator('.ctxmenu').count()).toBe(0)
      // Paste into the search box, then into the rename box: the pasted name is saved.
      await search.focus()
      await page.keyboard.press('ControlOrMeta+v')
      expect(await search.inputValue()).toBe(dropId)
      await search.fill('')
      await row('Delete me').click({ button: 'right' })
      expect(await page.locator('body').getAttribute('data-cm')).toBe('true')
      await page.keyboard.press('r')
      await page.locator('input.ren').click({ button: 'right' })
      expect(await page.locator('body').getAttribute('data-cm')).toBe('false')
      await page.locator('input.ren').press('ControlOrMeta+a')
      await page.locator('input.ren').press('ControlOrMeta+v')
      await page.locator('input.ren').press('Enter')
      await page.reload()
      await row(dropId).waitFor({ timeout: 15_000 })
      expect(await row(dropId).textContent()).toBe(dropId)

      // Delete asks inside the menu first.
      await row(dropId).click({ button: 'right' })
      await page.keyboard.press('d')
      await page.locator('.ctxq').getByText(`Delete "${dropId}"? This can't be undone.`).waitFor()
      await page.locator('.ctxmenu .btn.danger').click()
      await row(dropId).waitFor({ state: 'detached' })
      expect(existsSync(dropFile)).toBe(false)
      await page.reload()
      await row('Kept note').waitFor({ timeout: 15_000 })
      expect(await row(dropId).count()).toBe(0)
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
      sample('page.html', '<h1>HTML_BODY</h1>\n<p>second</p>\n<script>parent.__xss=4</script>'),
      sample('chart.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>parent.__xss=5</script><rect width="200" height="100"/></svg>'),
      sample('book.xlsx', new Uint8Array(await book.xlsx.writeBuffer())),
      sample('letter.docx', await tinyDocx('DOCX_BODY')),
      sample('slides.pdf', tinyPdf(['PAGE_ONE', 'PAGE_TWO'])),
      sample('memo.rtf', '{\\rtf1\\ansi RTF_BODY\\par}'),
      sample('long.log', `${Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n')}\nLONG_LAST_LINE`),
      sample('long.csv', `${Array.from({ length: 600 }, (_, i) => `r${i},${i}`).join('\n')}\nCSV_LAST_ROW,1`),
    ]
    const notes = join(home, 'notes.txt')
    writeFileSync(notes, 'first line\nNOTES_BODY\nlast line')
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
      // A long file shows its start and a "Show all" button that loads the rest in place.
      for (const [name, last] of [['long.log', 'LONG_LAST_LINE'], ['long.csv', 'CSV_LAST_ROW']]) {
        await open(name)
        await preview.getByRole('button', { name: 'Show all', exact: true }).click()
        await showing(preview.locator('.preview-body').getByText(last).last().waitFor(), preview)
        expect(await preview.getByRole('button', { name: 'Show all', exact: true }).count()).toBe(0)
        expect(await preview.locator('.preview-body').getByText(/download/i).count()).toBe(0)
      }
      await open('table.csv')
      await preview.locator('.sheet td', { hasText: 'x, y' }).waitFor()
      await open('page.html')
      const frame = preview.locator('iframe.preview-frame')
      await frame.waitFor()
      expect(await frame.getAttribute('sandbox')).toBe('')
      await page.frameLocator('iframe.preview-frame').getByText('HTML_BODY').waitFor()
      await open('chart.svg')
      await preview.locator('img[src^="blob:"]').waitFor()
      // A click on the image pins a comment; Enter sends it as its own message (#709).
      const commentsBefore = promptsSeen.length
      const shape = (await preview.locator('.pinnable').boundingBox())!
      const spot = { position: { x: shape.width / 4, y: (shape.height * 3) / 4 } }
      await preview.locator('.pinnable').click(spot)
      await preview.getByLabel('Comment', { exact: true }).fill('PIN_NOTE')
      await page.keyboard.press('Escape')
      expect(await preview.locator('.cpin-box').count()).toBe(0)
      await preview.locator('.preview-name', { hasText: 'chart.svg' }).waitFor()
      await preview.locator('.pinnable').click(spot)
      // The mark is centred on the spot clicked.
      const mark = (await preview.locator('.cpin').boundingBox())!
      expect(Math.abs(mark.x + mark.width / 2 - (shape.x + spot.position.x))).toBeLessThan(1.5)
      expect(Math.abs(mark.y + mark.height / 2 - (shape.y + spot.position.y))).toBeLessThan(1.5)
      await preview.getByLabel('Comment', { exact: true }).fill('PIN_NOTE')
      await preview.getByLabel('Comment', { exact: true }).press('Enter')
      await preview.locator('.cpin.sent', { hasText: '1' }).waitFor()
      await page.locator('.msg.user', { hasText: 'PIN_NOTE' }).waitFor()
      for (let i = 0; i < 300 && promptsSeen.length === commentsBefore; i++) await Bun.sleep(100)
      expect(promptsSeen.slice(commentsBefore).join('\n')).toContain(JSON.stringify('Comment on `' + files[3] + '` (pinned at 25% from the left, 75% from the top): PIN_NOTE').slice(1, -1))
      expect(await input.inputValue()).toBe('')
      // Text, code and HTML source take a selection; tables take a cell; chat images open to pin.
      const comment = async (text: string) => {
        const before = promptsSeen.length
        await preview.getByLabel('Comment', { exact: true }).fill(text)
        await preview.getByLabel('Comment', { exact: true }).press('Enter')
        await page.locator('.msg.user', { hasText: text }).waitFor()
        for (let i = 0; i < 300 && promptsSeen.length === before; i++) await Bun.sleep(100)
        return promptsSeen.slice(before).join('\n')
      }
      const select = async (text: string) => {
        await preview.locator('.selectable', { hasText: text }).waitFor()
        const found = await page.evaluate((text: string) => {
          const root = document.querySelector('.preview .selectable')
          if (!root) return false
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const at = n.textContent!.indexOf(text)
            if (at < 0) continue
            const range = document.createRange()
            range.setStart(n, at)
            range.setEnd(n, at + text.length)
            getSelection()!.removeAllRanges()
            getSelection()!.addRange(range)
            root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            return true
          }
          return false
        }, text)
        expect(found).toBe(true)
        await preview.locator('.cpin-offer').click()
      }
      await open('notes.txt')
      await preview.getByText('NOTES_BODY').waitFor()
      await select('NOTES_BODY')
      expect(await comment('LINE_NOTE')).toContain('(line 2): LINE_NOTE')
      // A real mouse drag across lines names the range: from the start of one text to the end of another.
      const textBox = (text: string) =>
        page.evaluate((text: string) => {
          const root = document.querySelector('.preview .selectable')!
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const at = n.textContent!.indexOf(text)
            if (at < 0) continue
            const range = document.createRange()
            range.setStart(n, at)
            range.setEnd(n, at + text.length)
            const r = range.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          }
          throw new Error(`no ${text}`)
        }, text)
      const drag = async (from: string, to: string) => {
        await preview.locator('.selectable', { hasText: to }).waitFor()
        const a = await textBox(from)
        const b = await textBox(to)
        await page.mouse.move(a.x + 1, a.y + a.height / 2)
        await page.mouse.down()
        await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 8 })
        await page.mouse.up()
        await preview.locator('.cpin-offer').click()
      }
      await drag('first', 'last line')
      expect(await comment('RANGE_NOTE')).toContain('(lines 1-3): RANGE_NOTE')
      await open('readme.md')
      await select('MD_HEADING')
      expect(await comment('QUOTE_NOTE')).toContain('readme.md` (line 1, on \\"MD_HEADING\\"): QUOTE_NOTE')
      await drag('MD_HEADING', 'text')
      expect(await comment('MD_RANGE_NOTE')).toContain('readme.md` (line 1, on \\"MD_HEADING text\\"): MD_RANGE_NOTE')
      await open('page.html')
      await preview.getByRole('radio', { name: 'Source' }).click()
      // Highlighting replaces the plain code once it loads, which would drop a selection made before.
      await preview.locator('div.codeblock-body').waitFor()
      await select('HTML_BODY')
      expect(await comment('SOURCE_NOTE')).toContain('page.html` (line 1): SOURCE_NOTE')
      await drag('second', 'script')
      expect(await comment('SOURCE_RANGE_NOTE')).toContain('page.html` (lines 2-3): SOURCE_RANGE_NOTE')
      await open('table.csv')
      await preview.locator('.sheet td', { hasText: 'x, y' }).click()
      expect(await comment('CELL_NOTE')).toContain('table.csv` (cell A2): CELL_NOTE')
      await preview.locator('.sheet td.cell-sent', { hasText: 'x, y' }).waitFor()
      await page.locator('.bubble-image-open').first().click()
      await preview.locator('.preview-name', { hasText: 'Image 1' }).waitFor()
      await preview.locator('.pinnable').click({ position: { x: 1, y: 1 } })
      expect(await comment('IMAGE_NOTE')).toContain('Comment on image 1 of my message \\"FILES readme.md table.csv')
      await open('book.xlsx')
      await preview.getByRole('tab', { name: 'Second' }).click()
      await preview.getByText('SECOND_SHEET_CELL').waitFor({ timeout: 30_000 })
      await open('letter.docx')
      await preview.locator('.docx-page', { hasText: 'DOCX_BODY' }).waitFor({ timeout: 30_000 })
      await drag('DOCX_BODY', 'DOCX_BODY')
      expect(await comment('DOCX_NOTE')).toContain('letter.docx` (on \\"DOCX_BODY\\"): DOCX_NOTE')
      await open('slides.pdf')
      await preview.locator('.page-count', { hasText: '/ 2' }).waitFor({ timeout: 30_000 })
      await preview.getByRole('button', { name: 'Next page' }).click()
      await page.waitForFunction(
        () => (document.querySelector('.pager input') as HTMLInputElement | null)?.value === '2',
      )
      await open('memo.rtf')
      // Without LibreOffice the note asks for it. With it (the CI runners have it, found by the
      // server's own lookup), a converted page, or the preview's error when headless LibreOffice
      // fails, as it does on fresh runners. Either way the preview settles.
      const outcome = preview
        .getByText('LibreOffice')
        .or(preview.locator('.page-count', { hasText: '/ 1' }))
        .or(preview.getByText('Could not preview this file.'))
      await showing(outcome.first().waitFor({ timeout: 180_000 }), preview)
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
  }, 300_000)

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
      await panel.locator('.agent-feed .msg.user', { hasText: 'FOLLOWUP_MSG now' }).waitFor({ timeout: 5_000 })
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

      // `cost` is an alias of `usage`, which opens the page's own Usage settings: no model call.
      await input.fill('/cos')
      const usage = palette.getByRole('option', { name: /^\/usage/ })
      await usage.waitFor()
      expect(await usage.textContent()).toContain('cost')
      await input.press('Enter')
      expect(await input.inputValue()).toBe('/usage ')
      await palette.waitFor({ state: 'detached' })
      const before = promptsSeen.length
      await input.press('Enter')
      const settings = page.locator('.dialog', { hasText: 'Usage' })
      await settings.getByText('Cost $0.00').first().waitFor({ timeout: 30_000 })
      expect(promptsSeen.length).toBe(before)
      await page.keyboard.press('Escape')
      await settings.waitFor({ state: 'detached' })

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
      await showing(finished.waitFor({ timeout: 60_000 }), panel)
      if ((await finished.getAttribute('aria-expanded')) === 'false') await finished.click()
      await panel.locator('.agent-row', { hasText: 'two-phase' }).first().click()
      await panel.getByText('Phase 2/2 · Write').waitFor({ timeout: 30_000 })
      await panel.locator('.crumb').getByRole('button', { name: 'Expand' }).click()
      const lanes = page.locator('.kanban')
      await lanes.locator('.kcol header', { hasText: 'Gather' }).waitFor()
      await lanes.locator('.kcol header', { hasText: 'Write' }).waitFor()
      expect(await lanes.locator('.wcard b').allTextContents()).toEqual(['gather-a', 'write-b'])
      // A card in the lanes opens that agent's output at the dialog's bottom; the dialog stays.
      await lanes.locator('.wcard', { hasText: 'write-b' }).click()
      const out = page.locator('.wfd-out')
      await out.getByText('B_OUT').waitFor({ timeout: 30_000 })
      // The pane header already names the agent: no task card or read-only note under it.
      expect(await out.locator('.agent-pane > .card, .agent-pane > .note').count()).toBe(0)
      // Picking another agent swaps the conversation below.
      await lanes.locator('.wcard', { hasText: 'gather-a' }).click()
      await out.locator('.fhead', { hasText: 'gather-a' }).waitFor()
      await out.getByText('A_OUT').waitFor({ timeout: 30_000 })
      expect(await out.getByText('B_OUT').count()).toBe(0)
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
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
      // A teammate's report is not the user's prompt: the untitled row keeps the last one typed.
      await page.waitForTimeout(1_000)
      const rowTitles = async () =>
        ((await page.evaluate(async () => (await fetch('/api/sidebar?limit=20')).json())) as { sessions: { title: string }[] }).sessions.map(x => x.title)
      expect(await rowTitles()).toContain('please MAKE_TEAM now')
      await team.locator('.agent-row', { hasText: 'Messages' }).click()
      await panel.locator('.team-timeline li', { hasText: 'ALICE_DONE' }).waitFor()
      await panel.getByRole('button', { name: 'Back' }).click()

      // A message to a running teammate goes straight into its conversation.
      await team.locator('.agent-row', { hasText: 'alice' }).click()
      const memberInput = panel.getByPlaceholder('Message alice')
      await memberInput.fill('MEMBER_PING hi')
      await memberInput.press('Enter')
      await panel.locator('.agent-feed .msg.user', { hasText: 'MEMBER_PING hi' }).waitFor({ timeout: 5_000 })
      await panel.getByText('MEMBER_PONG').waitFor({ timeout: 60_000 })
      await panel.getByRole('button', { name: 'Back' }).click()

      // The team outlives the turn: another prompt, and nobody has stopped.
      await input.fill('hello after the team')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').last().waitFor({ timeout: 30_000 })
      expect(await team.locator('.member-stopped').count()).toBe(0)

      // The row follows the turn once the CLI has written it (it writes up to 100 ms after the result).
      await page.locator('.session-row', { hasText: 'hello after the team' }).waitFor({ timeout: 30_000 })

      // A reload rebuilds the panel from what the server replays.
      await page.reload()
      // An untitled row shows the last prompt.
      await page.locator('.session-row', { hasText: 'hello after the team' }).locator('.session-title').click()
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
      await showing(dialog.getByText('Claude wants to use Edit').waitFor({ timeout: 30_000 }), page.locator('.feed'))
      await dialog.getByRole('option', { name: /Allow once/ }).click()
      await page.getByText('WEB_DONE').waitFor({ timeout: 30_000 })
      expect(readFileSync(join(workspace, 'edit.txt'), 'utf8')).toBe('alpha\ngamma\n')
      // The answer stays where the request was, and the card shows the diff.
      expect(await page.locator('.toolcard .tdec').textContent()).toBe('Allowed once')
      const card = page.locator('.toolcard', { has: page.locator('.tname', { hasText: 'Edit' }) })
      expect(await card.locator('.tcmd').textContent()).toBe('edit.txt')
      expect(await card.locator('.dl.del span').textContent()).toBe('beta')
      expect(await card.locator('.dl.add span').textContent()).toBe('gamma')
      expect(await card.locator('.dstat').allTextContents()).toEqual(['+1', '−1'])
      expect(await card.locator('.tfoot').textContent()).toContain(`~${sep}workspace${sep}edit.txt`)
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
      // The two updates land one after the other; between them the pin names the next todo.
      await pin.locator('.ptxt', { hasText: /^Writing tests$/ }).waitFor({ timeout: 30_000 })
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

  it('runs a project: the coordinator dispatches two tasks and resumes on reopen', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US' })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()

      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('E2E project')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.locator('#pj-instr').fill('PROJECT_RULES_MARK')
      await dialog.locator('.pj-model').click()
      await page.getByRole('menuitemradio', { name: /^Haiku/ }).click()
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await page.locator('#projview .pv-head b', { hasText: 'E2E project' }).waitFor({ timeout: 30_000 })
      await page.waitForFunction(() => document.body.classList.contains('proj'))
      // The session's own side panel is hidden in a project.
      expect(await page.locator('.side').isVisible()).toBe(false)

      // On a short screen the settings dialog's task default menu is not clipped by the dialog body
      // (#731): every row can be clicked, and a model and effort picked and the menu closed.
      await page.setViewportSize({ width: 1280, height: 400 })
      await page.getByRole('button', { name: 'Project settings' }).click()
      const settings = page.locator('.dialog')
      await settings.locator('.pj-model').click()
      const taskMenu = settings.locator('[role=menu]')
      const unreachable = await taskMenu.evaluate((menu: HTMLElement) => {
        menu.scrollTop = 0
        const box = menu.getBoundingClientRect()
        if (box.top < 0 || box.bottom > innerHeight) return [`menu ${box.top}..${box.bottom} of ${innerHeight}`]
        return Array.from(menu.querySelectorAll<HTMLElement>('button[role=menuitemradio]')).flatMap(row => {
          row.scrollIntoView({ block: 'nearest' })
          const r = row.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return hit && row.contains(hit) ? [] : [row.textContent ?? '']
        })
      })
      expect(unreachable).toEqual([])
      await taskMenu.getByRole('menuitemradio', { name: /^Opus/ }).click()
      await settings.locator('.pj-model').click()
      await taskMenu.getByRole('radio', { name: 'high', exact: true }).click()
      await page.keyboard.press('Escape')
      expect(await taskMenu.count()).toBe(0)
      expect(await settings.locator('.pj-model').textContent()).toMatch(/^Opus.* · high/)
      await settings.getByRole('button', { name: 'Close', exact: true }).click()
      await page.setViewportSize({ width: 1280, height: 720 })

      const input = page.locator('.pv-chat').getByLabel('Message', { exact: true })
      expect(await input.getAttribute('placeholder')).toBe('Tell the coordinator what to do')
      await input.fill('please DISPATCH_TWO')
      await input.press('Enter')
      // Both tasks: inline "Handed to" links in the middle, cards in the right column, then their notices.
      await page.locator('.pv-chat .tl-chip', { hasText: 'Task two' }).waitFor({ timeout: 60_000 })
      expect(await page.locator('.pv-chat .tl-chip').count()).toBe(2)
      await page.locator('.pjlist .pjcard', { hasText: 'Task one' }).waitFor({ timeout: 60_000 })
      await page.locator('.pjlist .pjcard', { hasText: 'Task two' }).waitFor()
      await page.locator('.pv-chat .pj-note', { hasText: 'Task "Task one" finished' }).waitFor({ timeout: 60_000 })
      await page.locator('.pv-chat .pj-note', { hasText: 'Task "Task two" finished' }).waitFor({ timeout: 60_000 })
      await page.locator('.pv-chat').getByText('COORD_SAW_RESULT').first().waitFor({ timeout: 60_000 })
      expect(await page.locator('.pjlist .grp-h').first().textContent()).toBe('Needs you')

      // The `-p` child really ran on the coordinator prompt, with the project instructions appended.
      expect(coordinatorSeen.length).toBeGreaterThan(0)
      expect(coordinatorSeen[0]![0]).toContain('PROJECT_RULES_MARK')
      expect(coordinatorSeen[0]![1]).toContain('DISPATCH_TWO')

      // A task opens with its brief from the coordinator.
      await page.locator('.pjlist .pjcard', { hasText: 'Task one' }).click()
      await page.locator('.pjbrief', { hasText: 'WORKER_ONE do the first part' }).waitFor()

      // The sidebar row's hover card counts the coordinator's tasks.
      await page.mouse.move(800, 400)
      // A project row has no pin button, so hovering it keeps its badge in place.
      const badge = page.locator('.pjrow', { hasText: 'E2E project' }).locator('.pjn')
      const badgeX = (await badge.boundingBox())!.x
      await page.locator('.pjrow', { hasText: 'E2E project' }).hover()
      expect((await badge.boundingBox())!.x).toBe(badgeX)
      const card = page.locator('.sbtip')
      await card.locator('span', { hasText: /^Tasks/ }).getByText('2 tasks').waitFor()
      // Both finished and not yet looked at.
      await card.locator('span', { hasText: /^Needs you/ }).getByText('2 tasks').waitFor()
      expect(await card.textContent()).toContain(`Folder ~${sep}workspace`)
      await page.mouse.move(800, 400)

      const projects = (await page.evaluate(async () => (await fetch('/api/projects')).json())) as {
        id: string
        coordinator_session_id: string
        worker_model: string
      }[]
      expect(projects).toHaveLength(1)
      const [project] = projects
      expect(project!.worker_model).toBe('haiku')
      const sessionId = project!.coordinator_session_id

      // Stop the coordinator, reload and reopen: the same session resumes with its history.
      await page.evaluate(async (id: string) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }), sessionId)
      await page.goto(new URL(signInUrl).origin)
      await page.locator('.pjrow', { hasText: 'E2E project' }).click()
      await page.locator('.pv-chat').getByText('please DISPATCH_TWO').waitFor({ timeout: 30_000 })
      const seen = coordinatorSeen.length
      const again = page.locator('.pv-chat').getByLabel('Message', { exact: true })
      await again.fill('AFTER_RESUME')
      await again.press('Enter')
      await page.locator('.pv-chat').getByText('COORD_RESUMED').waitFor({ timeout: 60_000 })
      expect(coordinatorSeen.slice(seen).some(([, messages]) => messages.includes('DISPATCH_TWO'))).toBe(true)
      const reopened = (await page.evaluate(async () => (await fetch('/api/projects')).json())) as {
        coordinator_session_id: string
      }[]
      expect(reopened[0]!.coordinator_session_id).toBe(sessionId)

      // New instructions restart the coordinator under the same page socket.
      const patched = await page.evaluate(
        async (id: string) =>
          (await fetch(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ instructions: 'RULES_V2' }) })).status,
        project!.id,
      )
      expect(patched).toBe(200)
      const beforeRestart = coordinatorSeen.length
      await again.fill('AFTER_RESTART')
      await again.press('Enter')
      await page.locator('.pv-chat').getByText('COORD_RESTARTED').waitFor({ timeout: 60_000 })
      const restarted = coordinatorSeen.slice(beforeRestart).find(([, messages]) => messages.includes('AFTER_RESTART'))!
      expect(restarted[0]).toContain('RULES_V2')
      expect(restarted[0]).not.toContain('PROJECT_RULES_MARK')

      // R renames the project from its sidebar menu and D deletes it after asking.
      const pjrow = page.locator('.pjrow', { hasText: 'E2E project' })
      await pjrow.click({ button: 'right' })
      await page.keyboard.press('r')
      await page.locator('input.ren').fill('Renamed project')
      await page.locator('input.ren').press('Enter')
      await page.locator('.pjrow', { hasText: 'Renamed project' }).waitFor()
      await page.locator('.pjrow', { hasText: 'Renamed project' }).click({ button: 'right' })
      await page.keyboard.press('d')
      await page.locator('.ctxq').getByText('Delete "Renamed project"? This can\'t be undone.').waitFor()
      await page.locator('.ctxmenu .btn.danger').click()
      await page.locator('.pjrow').waitFor({ state: 'detached' })
      expect(await page.evaluate(async () => (await fetch('/api/projects')).json())).toEqual([])
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 180_000)

  it('opens the extension dialogs: stats, hooks, skills and memory', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    const readJson = (file: string) =>
      existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>) : {}
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      // The resource menu has no counts (#588).
      expect(await page.locator('.snav .cnt').count()).toBe(0)
      // The side panel tabs scroll inside their row; the page never scrolls sideways.
      const noPageScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
      await page.locator('.session-row').first().locator('.session-title').click()
      await page.locator('.side .tabs').waitFor()
      expect(await noPageScroll()).toBe(true)
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await noPageScroll()).toBe(true)
      await page.setViewportSize({ width: 1440, height: 900 })
      const dialog = page.locator('.dialog')
      const close = async () => {
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
      }

      // Stats: KPI tiles, chart and a heatmap cell that shows its count on hover.
      await page.locator('#acct-btn').click()
      await page.locator('#acct-menu').getByRole('menuitem', { name: /Stats/ }).click()
      const cell = dialog.locator('.heat i[data-i]').last()
      await cell.waitFor({ timeout: 15_000 })
      await dialog.locator('svg[role=img]').first().waitFor()
      await cell.hover()
      const tip = dialog.locator('#heat-tip')
      await tip.waitFor()
      expect(await tip.textContent()).toMatch(/\d/)
      await close()

      // Hooks: add one to user settings, then delete it.
      const userSettings = join(home, '.claude', 'settings.json')
      await page.locator('.snav button', { hasText: 'Hooks' }).click()
      await dialog.locator('[data-hook-new]').click()
      await dialog.locator('#hk-matcher').fill('Bash')
      await dialog.locator('#hk-cmd').fill('echo e2e-hook')
      await dialog.locator('#hook-form button[type=submit]').click()
      const del = dialog.locator('.hookrow', { hasText: 'echo e2e-hook' }).locator('[data-hook-del]')
      await del.waitFor()
      expect(readJson(userSettings).hooks).toEqual({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo e2e-hook', timeout: 60 }] }],
      })
      await del.click()
      await del.waitFor({ state: 'detached' })
      expect(JSON.stringify(readJson(userSettings).hooks ?? {})).not.toContain('e2e-hook')
      await close()

      // Skills: preview SKILL.md and turn the skill off in local settings.
      const localSettings = join(workspace, '.claude', 'settings.local.json')
      await page.locator('.snav button', { hasText: 'Skills' }).click()
      await dialog.locator('#skill-q').fill('e2e-skill')
      await dialog.locator('[data-skill="e2e-skill"]').click()
      await dialog.locator('.memview', { hasText: 'E2E_SKILL_BODY' }).waitFor()
      const toggle = dialog.locator('.acts [role=switch]')
      expect(await toggle.getAttribute('aria-checked')).toBe('true')
      await toggle.click()
      await page.waitForFunction(
        () => document.querySelector('.dialog .acts [role=switch]')?.getAttribute('aria-checked') === 'false',
      )
      expect(readJson(localSettings).skillOverrides).toEqual({ 'e2e-skill': 'off' })
      await toggle.click()
      await page.waitForFunction(
        () => document.querySelector('.dialog .acts [role=switch]')?.getAttribute('aria-checked') === 'true',
      )
      expect(readJson(localSettings).skillOverrides?.['e2e-skill']).toBeUndefined()
      await close()

      // Memory: the user CLAUDE.md is listed and shown in the viewer.
      await page.locator('.snav button', { hasText: 'Memory' }).click()
      const userMemory = dialog.locator('#memlist button', { hasText: 'User instructions' })
      await userMemory.waitFor({ timeout: 15_000 })
      await userMemory.click()
      await dialog.locator('.memview', { hasText: 'E2E_MEMORY_MARKER' }).waitFor()
      await dialog.locator('#mem-q').fill('E2E_MEMORY')
      await dialog.locator('.memview mark', { hasText: 'E2E_MEMORY' }).waitFor()
      await close()
      expect(errors).toEqual([])
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
      // Each terminal is a drawer: its row toggles the screen, Stop sits on the row.
      const first = panel.locator('.term').nth(0)
      const row = first.locator('.termrow')
      await row.waitFor({ timeout: 15_000 })
      expect(await row.textContent()).toContain('bash --norc')
      expect(await row.locator('.badge').textContent()).toBe('running')
      expect(await row.locator('.meta2').textContent()).toBe('Main session opened · 80×12')
      // The server sends styled spans; the page only maps them to classes.
      const screen = first.getByLabel('Terminal screen')
      await screen.locator('.f31', { hasText: 'RED_MARK' }).waitFor({ timeout: 15_000 })
      expect(await screen.textContent()).toContain('RED_MARK ready')

      const typed = first.getByLabel('Type into the terminal, Enter to submit')
      await typed.fill('hello-from-web')
      await typed.press('Enter')
      // The tty echoes the line and cat prints it back.
      await page.waitForFunction(
        () => (document.querySelector('.term .screen')?.textContent ?? '').split('hello-from-web').length === 3,
        undefined,
        { timeout: 15_000 },
      )

      // A second terminal opens next to the first; both screens show at once.
      await input.fill('please OPEN_TERMINAL_TWO')
      await input.press('Enter')
      await dialog.getByRole('option', { name: /Allow once/ }).click()
      await page.getByText('WEB_DONE').nth(1).waitFor({ timeout: 30_000 })
      const second = panel.locator('.term').nth(1)
      await second.getByLabel('Terminal screen').getByText('SECOND_MARK').waitFor({ timeout: 15_000 })
      expect(await panel.locator('.term.open').count()).toBe(2)
      expect(await screen.textContent()).toContain('hello-from-web')

      await row.click()
      await screen.waitFor({ state: 'detached' })
      expect(await row.getAttribute('aria-expanded')).toBe('false')
      await row.click()
      await screen.locator('.f31', { hasText: 'RED_MARK' }).waitFor({ timeout: 15_000 })

      await row.getByRole('button', { name: 'Stop', exact: true }).click()
      await row.locator('.badge.killed').waitFor({ timeout: 15_000 })
      await typed.waitFor({ state: 'detached' })
      await row.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached' })
      // The stopped terminal keeps its last screen; the other one still runs.
      expect(await screen.textContent()).toContain('RED_MARK ready')
      expect(await second.locator('.termrow .badge').textContent()).toBe('running')
      await second.locator('.termrow').getByRole('button', { name: 'Stop', exact: true }).click()
      await second.locator('.termrow .badge.killed').waitFor({ timeout: 15_000 })

      await input.fill('please BG_SHELL')
      await input.press('Enter')
      // echo and sleep are read-only, so this one runs without asking.
      await page.getByText('WEB_DONE').nth(2).waitFor({ timeout: 30_000 })
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
      // pgrep is POSIX only.
      if (process.platform !== 'win32') expect(Bun.spawnSync(['pgrep', '-f', `${BG_MARK}; sleep 300`]).exitCode).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('runs project tasks: approval, done, copy, model, stop, board, splitter and resume after a restart', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      writeFileSync(join(workspace, 'slow.txt'), 'slow\n')
      // Session sockets pass through; while refuseStop is set, the next stop_task is answered with an error.
      let refuseStop = false
      await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws$/, (ws: any) => {
        const server = ws.connectToServer()
        ws.onMessage((raw: string) => {
          if (!refuseStop || !String(raw).includes('"subtype":"stop_task"')) return server.send(raw)
          const msg = JSON.parse(String(raw)) as { request_id?: string }
          refuseStop = false
          ws.send(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'STOP_REFUSED' } }) + '\n')
        })
        server.onMessage((raw: string) => ws.send(raw))
      })
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })

      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('Task project')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await page.locator('#projview .pv-head b', { hasText: 'Task project' }).waitFor({ timeout: 30_000 })
      const project = ((await page.evaluate(async () => (await fetch('/api/projects')).json())) as { id: string; name: string }[]).find(
        p => p.name === 'Task project',
      )!
      const tasksOf = async () =>
        (await page.evaluate(async (id: string) => (await fetch(`/api/projects/${id}/tasks`)).json(), project.id)) as {
          title: string
          state: string
          model: string | null
        }[]
      const reopen = async () => {
        await page.locator('.pjrow', { hasText: 'Task project' }).click()
        await page.locator('#projview .pv-head b', { hasText: 'Task project' }).waitFor({ timeout: 30_000 })
      }

      const chatInput = page.locator('.pv-chat').getByLabel('Message', { exact: true })
      await chatInput.fill('please DISPATCH_P3')
      await chatInput.press('Enter')
      const side = page.locator('.pv-side')
      const cardOf = (title: string) => side.locator('.pjlist .pjcard', { has: page.locator('.tt', { hasText: new RegExp(`^${title}$`) }) })
      const backToList = () => side.locator('.pv-crumb button').click()
      const flash = page.locator('.flash')
      for (const title of ['Ask', 'Quick', 'Slow']) await cardOf(title).waitFor({ timeout: 60_000 })

      // Approval: the worker's Bash request waits in its own task, blocked, and is answered with 1.
      await cardOf('Ask').locator('.pjbadge.blocked').waitFor({ timeout: 60_000 })
      expect(await page.locator('.pv-chat .askdock').count()).toBe(0)
      await cardOf('Ask').click()
      expect(await side.locator('.pjbrief').textContent()).toBe('WORKER_ASK create asked.txt')
      await side.locator('.askdock').getByText('Claude wants to run a command').waitFor({ timeout: 30_000 })
      expect(await side.locator('.askdock code').textContent()).toContain('touch asked.txt')
      // A page opened later still gets the unanswered request.
      await page.reload()
      await reopen()
      await cardOf('Ask').click()
      await side.locator('.askdock').getByText('Claude wants to run a command').waitFor({ timeout: 30_000 })
      expect(await side.locator('.askdock').count()).toBe(1)
      await side.locator('.pjcheck').click()
      await page.keyboard.press('1')
      await side.getByText('ASK_OUT').waitFor({ timeout: 60_000 })
      expect(existsSync(join(workspace, 'asked.txt'))).toBe(true)
      await side.locator('.toolcard', { has: page.locator('.tname', { hasText: 'Bash' }) }).waitFor()
      // Done: from review, kept across a reload.
      await side.locator('.pjcheck .pjbadge.review').waitFor({ timeout: 30_000 })
      await side.getByRole('button', { name: 'Mark done' }).click()
      await side.locator('.pjcheck .pjbadge.done').waitFor()
      await page.reload()
      await reopen()
      await cardOf('Ask').locator('.pjbadge.done').waitFor({ timeout: 30_000 })
      expect((await tasksOf()).find(x => x.title === 'Ask')!.state).toBe('done')

      // Progress: the slow task's card counts its time and tokens.
      await page.waitForFunction(() => {
        const card = Array.from(document.querySelectorAll('.pv-side .pjcard')).find(c => c.querySelector('.tt')?.textContent === 'Slow')
        const meta = card?.querySelector('.mt')?.textContent ?? ''
        return /[1-9]\d*s · /.test(meta) && /[1-9]\.\dk tok/.test(meta)
      }, undefined, { timeout: 30_000 })

      // Right click → C copies the brief to the real clipboard; paste it into the task's own box.
      await cardOf('Quick').locator('.pjbadge.review').waitFor({ timeout: 60_000 })
      await cardOf('Quick').click({ button: 'right' })
      const menu = page.getByRole('menu', { name: 'Task actions' })
      await menu.waitFor()
      expect(await menu.getByRole('menuitem', { name: /Stop/ }).isDisabled()).toBe(true)
      await page.keyboard.press('c')
      await flash.getByText('Copied').waitFor()
      await menu.waitFor({ state: 'detached' })
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('WORKER_QUICK answer quickly')
      await cardOf('Quick').click()
      const taskInput = side.getByLabel('Message', { exact: true })
      expect(await taskInput.getAttribute('placeholder')).toBe('Message this task; it resumes with its context')
      await taskInput.click()
      await page.keyboard.press('ControlOrMeta+v')
      expect(await taskInput.inputValue()).toBe('WORKER_QUICK answer quickly')
      await page.keyboard.type(' QUICK_MORE')
      // Message: an ended task resumes on the model picked for it.
      await side.getByRole('button', { name: 'Model' }).click()
      await page.getByRole('menuitemradio', { name: /^Sonnet/ }).click()
      expect(await side.getByRole('button', { name: 'Model' }).textContent()).toMatch(/^Sonnet/)
      await taskInput.press('Enter')
      await side.locator('.msg.user', { hasText: 'QUICK_MORE' }).waitFor({ timeout: 15_000 })
      await side.getByText('QUICK_AGAIN').waitFor({ timeout: 60_000 })
      expect(resumedModels.some(m => m.includes('sonnet'))).toBe(true)
      expect((await tasksOf()).find(x => x.title === 'Quick')!.model).toContain('sonnet')

      // A running task queues a message; S in its menu stops it.
      await backToList()
      await cardOf('Slow').click()
      await taskInput.fill('SLOW_NOTE')
      await taskInput.press('Enter')
      await side.locator('.msg.user', { hasText: 'SLOW_NOTE' }).waitFor({ timeout: 15_000 })
      await backToList()
      // A refused stop says so, and the task keeps running.
      refuseStop = true
      await cardOf('Slow').click({ button: 'right' })
      await menu.waitFor()
      await page.keyboard.press('s')
      await flash.getByText('STOP_REFUSED').waitFor({ timeout: 30_000 })
      expect(await cardOf('Slow').locator('.pjbadge.stopped').count()).toBe(0)
      await cardOf('Slow').click({ button: 'right' })
      await menu.waitFor()
      await page.keyboard.press('s')
      await showing(cardOf('Slow').locator('.pjbadge.stopped').waitFor({ timeout: 30_000 }), side)
      await cardOf('Slow').click()
      expect(await taskInput.getAttribute('placeholder')).toBe('Task stopped')
      expect(await taskInput.isDisabled()).toBe(true)
      await backToList()

      // The board: lanes by state, with the same right-click menu; O opens the task.
      await side.getByRole('button', { name: 'Board' }).click()
      const board = page.locator('.dialog .lanes')
      const lane = (name: string) => board.locator('.lane', { has: page.locator('h3', { hasText: name }) })
      await lane('Review').locator('.wcard', { hasText: 'Quick' }).waitFor({ timeout: 30_000 })
      expect(await lane('Ended').locator('.wcard').count()).toBe(2)
      await lane('Review').locator('.wcard', { hasText: 'Quick' }).click({ button: 'right' })
      await menu.waitFor()
      await page.keyboard.press('o')
      await page.locator('.dialog').waitFor({ state: 'detached' })
      expect(await side.locator('.pv-crumb').textContent()).toContain('Quick')
      await backToList()

      // The splitter: ← narrows the chat by 24px, a drag sets it, and the width survives a reload.
      const chatWidth = async () => (await page.locator('.pv-chat').boundingBox())!.width
      const before = await chatWidth()
      await side.locator('.pv-drag').focus()
      await page.keyboard.press('ArrowLeft')
      expect(Math.round(await chatWidth())).toBe(Math.round(before - 24))
      const handle = (await side.locator('.pv-drag').boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
      await page.mouse.down()
      await page.mouse.move(handle.x - 100, handle.y + 200, { steps: 5 })
      await page.mouse.up()
      const dragged = await chatWidth()
      expect(Math.abs(dragged - (before - 24 - 100))).toBeLessThan(8)
      await page.reload()
      await reopen()
      expect(Math.abs((await chatWidth()) - dragged)).toBeLessThan(2)

      // The coordinator's model is kept in the project.
      const chatModel = page.locator('.pv-chat').getByRole('button', { name: 'Model' })
      await chatModel.click()
      await page.getByRole('menuitemradio', { name: /^Haiku/ }).click()
      await page.waitForFunction(
        async (id: string) =>
          ((await (await fetch('/api/projects')).json()) as { id: string; coordinator_model: string | null }[]).find(p => p.id === id)
            ?.coordinator_model?.includes('haiku'),
        project.id,
        { timeout: 30_000 },
      )

      // Resume after a server restart: the hung task is stopped, and a message continues it.
      await chatInput.fill('please DISPATCH_HANG')
      await chatInput.press('Enter')
      await cardOf('Hang').waitFor({ timeout: 60_000 })
      const workerAsked = () => promptsSeen.some(p => p.includes('WORKER_HANG') && !p.includes('DISPATCH_HANG'))
      for (let i = 0; i < 300 && !workerAsked(); i++) await Bun.sleep(100)
      expect(workerAsked()).toBe(true)
      // Windows has no SIGTERM: the kill below is immediate, so let the worker's transcript reach disk first.
      const workerSaved = () =>
        [...new Bun.Glob('**/subagents/**/agent-*.jsonl').scanSync({ cwd: join(home, '.claude', 'projects'), absolute: true })].some(f =>
          readFileSync(f, 'utf8').includes('WORKER_HANG'),
        )
      for (let i = 0; i < 300 && !workerSaved(); i++) await Bun.sleep(100)
      expect(workerSaved()).toBe(true)
      web.kill('SIGTERM')
      expect(await web.exited).toBe(143)
      await startWeb()
      await page.goto(signInUrl)
      await reopen()
      await cardOf('Hang').locator('.pjbadge.stopped').waitFor({ timeout: 30_000 })
      expect(await cardOf('Hang').locator('.sm').textContent()).toMatch(/^Stopped (by a server restart|when the coordinator exited); send a message to continue$/)
      expect(await cardOf('Ask').locator('.pjbadge.done').count()).toBe(1)
      await page.waitForFunction(
        () => /Haiku/.test(document.querySelector('.pv-chat .footbtn[aria-label="Model"]')?.textContent ?? ''),
        undefined,
        { timeout: 30_000 },
      )
      await cardOf('Hang').click()
      await taskInput.fill('HANG_RESUME')
      await taskInput.press('Enter')
      await showing(side.locator('.msg.user', { hasText: 'HANG_RESUME' }).waitFor({ timeout: 15_000 }), side)
      await side.getByText('HANG_BACK').waitFor({ timeout: 60_000 })

      // The sidebar's counts come from the database.
      await page.mouse.move(800, 400)
      await page.locator('.pjrow', { hasText: 'Task project' }).hover()
      await page.locator('.sbtip').getByText('4 tasks').waitFor()
      expect(await tasksOf()).toHaveLength(4)
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 300_000)

  it('sweeps the page by keyboard, mouse and clipboard on a desktop screen', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"]).stdout.toString().trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
      // Whether the last right click was taken by the page (a custom menu) or left to the browser.
      await page.addInitScript(() =>
        addEventListener('contextmenu', e => document.documentElement.setAttribute('data-cm', String(e.defaultPrevented))),
      )
      await page.reload()
      const focused = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement
          return el.id || el.getAttribute('aria-label') || (el.textContent ?? '').trim()
        })
      const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('.dialog'))
      const box = page.getByLabel('Message', { exact: true })

      // The welcome box: Shift+Enter is a newline, paste works, right click keeps the browser's menu.
      await box.click()
      await page.keyboard.type('one')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('two')
      expect(await box.inputValue()).toBe('one\ntwo')
      await box.click({ button: 'right' })
      expect(await page.locator('html').getAttribute('data-cm')).toBe('false')
      await page.evaluate(() => navigator.clipboard.writeText('PASTED_PROMPT'))
      await box.fill('')
      await page.keyboard.press('ControlOrMeta+v')
      expect(await box.inputValue()).toBe('PASTED_PROMPT')
      await box.fill('')

      // A menu closed with Esc gives focus back to its button.
      const folder = page.locator('.wl-bar .footbtn').first()
      await folder.click()
      await page.getByLabel('Search folders', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      expect(await page.locator('.wl-pick').count()).toBe(0)
      expect(await page.evaluate(() => document.activeElement?.closest('.wl-bar .footbtn') !== null)).toBe(true)

      // Shortcuts: ? opens the list, Ctrl+K focuses search, Ctrl+Shift+O starts over.
      await page.locator('.welcome').click({ position: { x: 5, y: 5 } })
      await page.keyboard.press('?')
      await page.locator('.dialog h2', { hasText: 'Shortcuts' }).waitFor()
      await page.keyboard.press('Escape')
      await page.locator('.dialog').waitFor({ state: 'detached' })
      await page.keyboard.press('ControlOrMeta+k')
      expect(await focused()).toBe('Search sessions')
      await page.keyboard.press('Escape')

      // A dialog keeps Tab inside, a menu in it closes alone on Esc, and focus returns to the opener.
      const hooks = page.locator('#sessions nav button', { hasText: 'Hooks' })
      await hooks.focus()
      await page.keyboard.press('Enter')
      await page.locator('.dialog').waitFor()
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab')
        expect(await inDialog()).toBe(true)
      }
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Shift+Tab')
        expect(await inDialog()).toBe(true)
      }
      await page.locator('[data-hook-new]').click()
      await page.locator('#hk-event').click()
      await page.locator('.dialog [role="menu"]').waitFor()
      await page.keyboard.press('Escape')
      await page.locator('.dialog [role="menu"]').waitFor({ state: 'detached' })
      expect(await page.locator('.dialog').count()).toBe(1)
      await page.locator('#hk-cmd').focus()
      await page.evaluate(() => navigator.clipboard.writeText('echo SWEEP_HOOK'))
      await page.keyboard.press('ControlOrMeta+v')
      await page.locator('#hk-matcher').fill('Bash')
      await page.locator('#hk-matcher').press('Enter')
      await page.locator('.dialog').getByText('echo SWEEP_HOOK').waitFor()
      await page.keyboard.press('Escape')
      await page.locator('.dialog').waitFor({ state: 'detached' })
      expect(await focused()).toContain('Hooks')

      // The account menu: Esc from the Auth submenu returns to the account button; a dialog
      // opened from the menu returns there too. Settings persist after a reload.
      await page.locator('#acct-btn').click()
      await page.locator('#acct-menu .mi', { hasText: 'Auth' }).click()
      await page.locator('#auth-menu').waitFor()
      await page.keyboard.press('Escape')
      expect(await page.locator('#acct-menu').count()).toBe(0)
      expect(await focused()).toBe('acct-btn')
      await page.locator('#acct-btn').click()
      await page.locator('#acct-menu .mi', { hasText: 'Settings' }).click()
      const name = page.locator('#ui-name-input')
      await name.fill('')
      await page.evaluate(() => navigator.clipboard.writeText('SweepName'))
      await name.focus()
      await page.keyboard.press('ControlOrMeta+v')
      await page.locator('.dialog [role="radio"]', { hasText: 'Dark' }).click()
      await page.locator('.dialog .settabs button').nth(2).click()
      const feature = page.locator('.dialog [role="switch"]').first()
      const was = await feature.getAttribute('aria-checked')
      await feature.click()
      await page.waitForFunction(
        (v: string | null) => document.querySelector('.dialog [role="switch"]')?.getAttribute('aria-checked') !== v,
        was,
      )
      await page.waitForTimeout(600)
      await page.keyboard.press('Escape')
      expect(await focused()).toBe('acct-btn')
      await page.reload()
      await page.locator('#acct-btn').click()
      await page.locator('#acct-menu .mi', { hasText: 'Settings' }).click()
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
      expect(await page.locator('#ui-name-input').inputValue()).toBe('SweepName')
      await page.locator('.dialog .settabs button').nth(2).click()
      expect(await page.locator('.dialog [role="switch"]').first().getAttribute('aria-checked')).not.toBe(was)
      await page.locator('.dialog [role="switch"]').first().click()
      await page.locator('.dialog .settabs button').first().click()
      await page.locator('.dialog [role="radio"]', { hasText: 'System' }).click()
      await page.locator('#ui-name-input').fill('')
      await page.waitForTimeout(600)
      await page.keyboard.press('Escape')

      // A chat: Enter sends, the code block copies to the clipboard, a reply keeps the browser's menu.
      await box.fill('show MARKDOWN sweep')
      await box.press('Enter')
      const code = page.locator('.codeblock', { hasText: 'const answer' })
      await code.waitFor({ timeout: 30_000 })
      await code.getByRole('button', { name: 'Copy' }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const answer: number = 42')
      await page.locator('.feed').getByText('Report').click({ button: 'right' })
      expect(await page.locator('html').getAttribute('data-cm')).toBe('false')
      const cbox = page.locator('.cbox textarea')
      await cbox.click()
      await page.keyboard.type('a')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('b')
      expect(await cbox.inputValue()).toBe('a\nb')
      await cbox.fill('')
      // Shift+Tab cycles the permission mode; Ctrl+. opens the status panel.
      const mode = page.locator('.footbtn.perm')
      const before = await mode.textContent()
      await page.keyboard.press('Shift+Tab')
      await page.waitForFunction((b: string | null) => document.querySelector('.footbtn.perm')?.textContent !== b, before)
      await page.keyboard.press('ControlOrMeta+.')
      await page.locator('.side').waitFor()

      // The model and effort picked for a session survive a reload.
      const model = page.getByLabel('Model', { exact: true })
      await model.click()
      await page.locator('[role="menu"] [role="menuitemradio"]', { hasText: 'Haiku' }).click()
      await model.click()
      await page.getByRole('radio', { name: 'high', exact: true }).click()
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => /Haiku.*high/.test(document.querySelector('[aria-label="Model"]')?.textContent ?? ''))
      await page.waitForTimeout(500)
      await page.reload()
      await page.locator('#sessions .sess', { hasText: 'show MARKDOWN sweep' }).first().click()
      await page.locator('.codeblock', { hasText: 'const answer' }).waitFor({ timeout: 30_000 })
      await page.waitForFunction(() => /Haiku.*high/.test(document.querySelector('[aria-label="Model"]')?.textContent ?? ''), null, { timeout: 15_000 })
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 180_000)

  it('keeps menus, drawers and dialogs usable on a phone screen', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"]).stdout.toString().trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, hasTouch: true })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
      // On screen and not clipped or covered: the point at its center belongs to it.
      const inside = (sel: string) =>
        page.evaluate((s: string) => {
          const el = document.querySelector(s)!
          const r = el.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.contains(hit)
        }, sel)
      const focused = () => page.evaluate(() => document.activeElement?.className ?? '')
      const menuBtn = page.locator('.menu-btn').first()
      expect(await noScroll()).toBe(true)

      // Ctrl+K opens the drawer with the search box focused.
      await page.getByLabel('Message', { exact: true }).click()
      await page.keyboard.press('ControlOrMeta+k')
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search sessions')
      expect(await noScroll()).toBe(true)
      // A dialog opened from the drawer hands focus back to the menu button once both are closed.
      await page.locator('#sessions nav button', { hasText: 'Hooks' }).click()
      await page.locator('.dialog').waitFor()
      expect(await inside('.dialog > div')).toBe(true)
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('.dialog'))).toBe(true)
      await page.keyboard.press('Escape')
      await page.locator('.dialog').waitFor({ state: 'detached' })
      expect(await focused()).toContain('menu-btn')

      // Every chat menu stays on screen.
      const box = page.getByLabel('Message', { exact: true })
      await box.fill('hello phone sweep')
      await box.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      expect(await noScroll()).toBe(true)
      for (const [trigger, menu] of [
        [page.locator('.export .footbtn'), '.export [role="menu"]'],
        [page.getByLabel('Model', { exact: true }), '.composer [role="menu"]'],
        [page.locator('.footbtn.perm'), '.composer [role="menu"]'],
        [page.getByLabel('Add a file or skill'), '.composer .pop'],
      ] as const) {
        await trigger.click()
        await page.locator(menu).waitFor()
        expect(await inside(menu)).toBe(true)
        await page.keyboard.press('Escape')
        await page.locator(menu).waitFor({ state: 'detached' })
      }
      await menuBtn.click()
      await page.locator('#acct-btn').click()
      expect(await inside('#acct-menu')).toBe(true)
      await page.locator('#acct-menu .mi', { hasText: 'Auth' }).click()
      expect(await inside('#auth-menu')).toBe(true)
      await page.keyboard.press('Escape')
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 120_000)

  // Windows has no SIGTERM: kill() ends the process before it can remove the lock.
  it('gives every chat input the same palette, skills, + menu, @ files, mode and model', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      writeFileSync(join(workspace, 'slow.txt'), 'slow\n')
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()

      // `agent`: the box messages a subagent, which gets the text as typed (the
      // CLI's agent view does the same), so only skills are offered.
      const checkBox = async (scope: any, input: any, agent: boolean) => {
        const palette = scope.getByRole('listbox', { name: 'Completions' })
        await scope.getByRole('button', { name: 'Add a file or skill' }).click()
        const plus = scope.locator('.plusmenu')
        for (const name of ['Upload file', 'Add image', 'Use a skill', 'Mention a workspace file']) {
          await plus.getByRole('button', { name: new RegExp(name) }).waitFor({ timeout: 5_000 })
        }
        await plus.getByRole('button', { name: /Use a skill/ }).click()
        await showing(palette.getByRole('option', { name: /^\/e2e-skill/ }).waitFor({ timeout: 10_000 }), scope)
        expect(await palette.getByRole('option', { name: /^\/e2e-skill/ }).locator('em').textContent()).toBe('skill')
        await input.fill('/cont')
        await page.waitForTimeout(300)
        expect(await palette.getByRole('option', { name: /^\/context/ }).count()).toBe(agent ? 0 : 1)
        await input.fill('@slo')
        await palette.getByRole('option', { name: /slow\.txt/ }).waitFor({ timeout: 10_000 })
        await input.fill('')
        await scope.getByRole('button', { name: 'Model' }).waitFor({ timeout: 5_000 })
        // Shift+Tab cycles the permission mode, back to where it started.
        const mode = () => scope.locator('.perm').getAttribute('data-mode')
        const start = await mode()
        await input.focus()
        await page.keyboard.press('Shift+Tab')
        await page.waitForFunction(
          ([sel, was]: [string, string]) => document.querySelector(sel)?.getAttribute('data-mode') !== was,
          [agent ? '.pv-side .perm, aside.side .perm' : '.composer .perm', start],
          { timeout: 10_000 },
        )
        for (let i = 0; i < 6 && (await mode()) !== start; i++) {
          await page.keyboard.press('Shift+Tab')
          await page.waitForTimeout(300)
        }
        expect(await mode()).toBe(start)
        // A file dropped on the box attaches once; so does one picked with Upload file.
        await input.evaluate((el: HTMLElement) => {
          const data = new DataTransfer()
          data.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }))
          el.closest('form')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
        })
        await scope.locator('.attachment', { hasText: 'dropped.txt' }).waitFor({ timeout: 5_000 })
        await page.waitForTimeout(200)
        expect(await scope.locator('.attachment').count()).toBe(1)
        await scope.getByRole('button', { name: 'Remove dropped.txt' }).click()
        await scope.locator('input[type=file][aria-label="Upload file"]').setInputFiles({ name: 'picked.txt', mimeType: 'text/plain', buffer: Buffer.from('picked') })
        await scope.locator('.attachment', { hasText: 'picked.txt' }).waitFor({ timeout: 5_000 })
        await scope.getByRole('button', { name: 'Remove picked.txt' }).click()
        expect(await scope.locator('.attachment').count()).toBe(0)
      }
      const attach = (scope: any, name: string) =>
        scope.locator('input[type=file][aria-label="Upload file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })

      // A plain chat, and the background agent it starts, in the side panel.
      const input = page.locator('.main').getByLabel('Message', { exact: true })
      await input.fill('please SPAWNBG an agent')
      await input.press('Enter')
      await page.locator('.agent-chip').waitFor({ timeout: 30_000 })
      await checkBox(page.locator('.main .composer'), input, false)
      const panel = page.locator('aside.side')
      await panel.getByRole('tab', { name: /^Agents/ }).click()
      const finished = panel.getByRole('button', { name: /Ended/ })
      await finished.waitFor({ timeout: 60_000 })
      if ((await finished.getAttribute('aria-expanded')) === 'false') await finished.click()
      await panel.locator('.agent-row', { hasText: 'Look around' }).click()
      await panel.locator('.agent-feed').getByText('SUB_RESULT').first().waitFor({ timeout: 30_000 })
      const agentInput = panel.getByLabel('Message', { exact: true })
      // The agent's box sits at the bottom of the panel, level with the session's.
      const formBottom = async (scope: any) => {
        const b = await scope.locator('.composer form').first().boundingBox()
        return b.y + b.height
      }
      expect(Math.abs((await formBottom(panel)) - (await formBottom(page.locator('.main'))))).toBeLessThanOrEqual(4)
      await checkBox(panel, agentInput, true)
      // A slow upload of the first message's file must not let the second message overtake it or take the file too.
      await page.route(/\/api\/files\/[^?]+\?name=for-agent/, async (route: any) => {
        await new Promise(r => setTimeout(r, 800))
        await route.continue()
      })
      await agentInput.fill('/e2e-sk')
      await agentInput.press('Enter')
      expect(await agentInput.inputValue()).toBe('/e2e-skill ')
      await agentInput.pressSequentially('go')
      await attach(panel, 'for-agent.txt')
      await panel.locator('.attachment', { hasText: 'for-agent.txt' }).waitFor()
      await agentInput.press('Enter')
      // A second line typed right after: both show at once, in order, with no "queued" notice.
      await agentInput.fill('AND_ONE_MORE')
      await agentInput.press('Enter')
      const sentBubbles = panel.locator('.agent-feed .msg.user').filter({ hasText: /\/e2e-skill go|AND_ONE_MORE/ })
      await panel.locator('.agent-feed .msg.user', { hasText: 'AND_ONE_MORE' }).waitFor({ timeout: 5_000 })
      expect((await sentBubbles.allInnerTexts()).map(x => (x.includes('AND_ONE_MORE') ? 'second' : 'first'))).toEqual(['first', 'second'])
      expect(await panel.locator('.delivery').count()).toBe(0)
      expect(await panel.locator('.agent-feed .rw-btn').count()).toBe(0)
      await panel.locator('.agent-feed .msg.assistant', { hasText: 'SKILL_REACHED' }).waitFor({ timeout: 60_000 })
      await page.waitForTimeout(3_000)
      expect(await panel.locator('.agent-feed .msg.user', { hasText: '/e2e-skill go' }).count()).toBe(1)
      expect(await panel.locator('.agent-feed .msg.user', { hasText: 'AND_ONE_MORE' }).count()).toBe(1)
      // ↑ brings back what was sent to this agent, newest first.
      await agentInput.press('ArrowUp')
      expect(await agentInput.inputValue()).toBe('AND_ONE_MORE')
      await agentInput.press('ArrowUp')
      expect((await agentInput.inputValue()).startsWith('/e2e-skill go')).toBe(true)
      expect(promptsSeen.some(p => p.includes('/e2e-skill go') && p.includes('for-agent.txt'))).toBe(true)
      expect(promptsSeen.some(p => p.includes('for-agent (1).txt'))).toBe(false)
      await agentInput.fill('')
      // Signed out, the agent's box is disabled and says why, like the session's own.
      await page.route('**/api/account', async (route: any) => {
        const res = await route.fetch()
        await route.fulfill({ response: res, json: { ...(await res.json()), kind: null } })
      })
      await page.reload()
      // Newest first: an earlier test started a session with the same prompt.
      await page.locator('.session-row', { hasText: 'please SPAWNBG an agent' }).first().click()
      await panel.getByRole('tab', { name: /^Agents/ }).click()
      const ended = panel.getByRole('button', { name: /Ended/ })
      await ended.waitFor({ timeout: 30_000 })
      if ((await ended.getAttribute('aria-expanded')) === 'false') await ended.click()
      await panel.locator('.agent-row', { hasText: 'Look around' }).click()
      await agentInput.waitFor()
      expect(await input.getAttribute('placeholder')).toBe('Sign in to send messages')
      expect(await agentInput.getAttribute('placeholder')).toBe('Sign in to send messages')
      expect(await agentInput.isDisabled()).toBe(true)
      await page.unroute('**/api/account')
      await page.reload()
      await page.locator('.wl-hi, .main').first().waitFor()
      await page.locator('.session-row', { hasText: 'please SPAWNBG an agent' }).first().click()
      await input.waitFor()
      // The session's own box: a slow upload keeps two messages in order and sends the file once.
      await page.route(/\/api\/files\/[^?]+\?name=slow-main/, async (route: any) => {
        await new Promise(r => setTimeout(r, 800))
        await route.continue()
      })
      await attach(page.locator('.main .composer'), 'slow-main.txt')
      await page.locator('.main .attachment', { hasText: 'slow-main.txt' }).waitFor()
      await input.fill('MAIN_FIRST')
      await input.press('Enter')
      await input.fill('MAIN_SECOND')
      await input.press('Enter')
      await page.locator('.main .msg.user', { hasText: 'MAIN_SECOND' }).waitFor({ timeout: 30_000 })
      const mainSent = await page.locator('.main .msg.user').filter({ hasText: /MAIN_FIRST|MAIN_SECOND/ }).allInnerTexts()
      expect(mainSent.map(x => (x.includes('MAIN_SECOND') ? 'second' : 'first'))).toEqual(['first', 'second'])
      expect(promptsSeen.some(p => p.includes('slow-main (1).txt'))).toBe(false)


      // A project: the coordinator's box and a dispatched task's box.
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('Skill project')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await page.locator('#projview .pv-head b', { hasText: 'Skill project' }).waitFor({ timeout: 30_000 })
      const chatInput = page.locator('.pv-chat').getByLabel('Message', { exact: true })
      await chatInput.fill('please DISPATCH_SKILLCHK')
      await chatInput.press('Enter')
      const side = page.locator('.pv-side')
      const card = side.locator('.pjlist .pjcard', { has: page.locator('.tt', { hasText: /^Skillchk$/ }) })
      await card.locator('.pjbadge.review').waitFor({ timeout: 60_000 })
      await checkBox(page.locator('.pv-chat .composer'), chatInput, false)
      await card.click()
      await side.getByText('SKILLCHK_OUT').waitFor({ timeout: 30_000 })
      const taskInput = side.getByLabel('Message', { exact: true })
      await checkBox(side.locator('.composer'), taskInput, true)
      await taskInput.fill('/e2e-skill go')
      await attach(side.locator('.composer'), 'for-task.txt')
      await side.locator('.attachment', { hasText: 'for-task.txt' }).waitFor()
      await taskInput.press('Enter')
      await side.locator('.msg.user', { hasText: '/e2e-skill go' }).waitFor({ timeout: 60_000 })
      await side.locator('.msg', { hasText: 'SKILL_REACHED' }).waitFor({ timeout: 60_000 })
      await taskInput.press('ArrowUp')
      expect((await taskInput.inputValue()).startsWith('/e2e-skill go')).toBe(true)
      expect(promptsSeen.some(p => p.includes('/e2e-skill go') && p.includes('for-task.txt'))).toBe(true)

      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('shows a message sent to a running task, from the page and from the coordinator', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      writeFileSync(join(workspace, 'slow.txt'), 'slow\n')
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('Long project')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await page.locator('#projview .pv-head b', { hasText: 'Long project' }).waitFor({ timeout: 30_000 })
      const chatInput = page.locator('.pv-chat').getByLabel('Message', { exact: true })
      await chatInput.fill('please DISPATCH_LONG')
      await chatInput.press('Enter')
      const side = page.locator('.pv-side')
      const cardOf = (title: string) => side.locator('.pjlist .pjcard', { has: page.locator('.tt', { hasText: new RegExp(`^${title}$`) }) })
      await cardOf('LongA').locator('.pjbadge.running').waitFor({ timeout: 60_000 })
      await cardOf('LongB').locator('.pjbadge.running').waitFor({ timeout: 60_000 })
      await page.locator('.pv-chat').getByText('COORD_LAUNCHED').waitFor({ timeout: 60_000 })

      // From the page: typed into the running task, shown at once and once only.
      await cardOf('LongA').click()
      const taskInput = side.getByLabel('Message', { exact: true })
      await taskInput.fill('USER_NOTE for A')
      await taskInput.press('Enter')
      // Shown the moment it is sent, before the server has it.
      await side.locator('.msg.user', { hasText: 'USER_NOTE for A' }).waitFor({ timeout: 1_000 })
      // Its conversation is the worker's: no rewind of the coordinator's.
      expect(await side.locator('.rw-btn').count()).toBe(0)
      longGates.LONG_A!()
      await showing(side.getByText('LONG_A_SAW_NOTE').waitFor({ timeout: 60_000 }), side)
      await page.waitForTimeout(2_000)
      expect(await side.locator('.msg.user', { hasText: 'USER_NOTE for A' }).count()).toBe(1)
      expect(await page.getByText(/Queued; the agent/).count()).toBe(0)
      await side.locator('.pv-crumb button').click()

      // From the coordinator: its SendMessage shows in the worker's conversation.
      await chatInput.fill('please TELL_LONG_B')
      await chatInput.press('Enter')
      await page.locator('.pv-chat').getByText('COORD_LAUNCHED').nth(1).waitFor({ timeout: 60_000 })
      longGates.LONG_B!()
      await cardOf('LongB').click()
      await showing(side.getByText('LONG_B_SAW_NOTE').waitFor({ timeout: 60_000 }), side)
      await showing(side.locator('.msg', { hasText: 'COORD_NOTE for B' }).first().waitFor({ timeout: 15_000 }), side)
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('opens the / palette in the coordinator and a running task box, mid-turn and after a reload', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    const shots = process.env.CLAUDE_WEB_SHOTS
    try {
      let page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      writeFileSync(join(workspace, 'slow.txt'), 'slow\n')
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('Slash project')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await page.locator('#projview .pv-head b', { hasText: 'Slash project' }).waitFor({ timeout: 30_000 })
      const chat = page.locator('.pv-chat')
      const side = page.locator('.pv-side')
      const check = async (scope: any, skillOnly: boolean, shot: string) => {
        const input = scope.getByLabel('Message', { exact: true })
        await input.fill('/')
        const palette = scope.getByRole('listbox', { name: 'Completions' })
        try {
          await showing(palette.getByRole('option', { name: /^\/e2e-skill/ }).waitFor({ timeout: 10_000 }), scope)
          if (!skillOnly) await palette.getByRole('option', { name: /^\/context/ }).waitFor({ timeout: 10_000 })
        } finally {
          if (shots) await page.screenshot({ path: join(shots, `${shot}.png`) })
        }
        await input.fill('')
      }
      await check(chat, false, '1-coordinator-idle')
      await chat.getByLabel('Message', { exact: true }).fill('please DISPATCH_SLASH')
      await chat.getByLabel('Message', { exact: true }).press('Enter')
      const card = side.locator('.pjlist .pjcard', { has: page.locator('.tt', { hasText: /^SlashA$/ }) })
      await card.locator('.pjbadge.running').waitFor({ timeout: 60_000 })
      await check(chat, false, '2-coordinator-midturn')
      await card.click()
      await check(side, true, '3-task-midturn')
      // A page opened while the task still runs.
      await page.reload()
      await card.locator('.pjbadge.running').waitFor({ timeout: 60_000 })
      await check(chat, false, '4-coordinator-reloaded')
      await card.click()
      await check(side, true, '5-task-reloaded')
      // A second tab: the coordinator is attached to the first one.
      const other = await page.context().newPage()
      await other.goto(signInUrl)
      await other.locator('.wl-hi').waitFor()
      await other.locator('.sidebar, nav, aside').getByText('Slash project', { exact: true }).first().click()
      const otherCard = other.locator('.pv-side .pjlist .pjcard', { has: other.locator('.tt', { hasText: /^SlashA$/ }) })
      await otherCard.locator('.pjbadge.running').waitFor({ timeout: 60_000 })
      const swap = page
      page = other
      try {
        await otherCard.click()
        await check(other.locator('.pv-side'), true, '7-task-other-tab')
      } finally {
        page = swap
        await other.close()
      }
      longGates.SLASH!()
      await side.getByText('SLASH_OUT').waitFor({ timeout: 60_000 })
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('sends queued messages now, interrupting the turn, from the button and with ctrl+enter', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US' })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      await page.getByLabel('Message', { exact: true }).fill('HOLD_TURN one')
      await page.getByLabel('Message', { exact: true }).press('Enter')
      const input = page.locator('.main').getByLabel('Message', { exact: true })
      await input.waitFor({ timeout: 30_000 })
      const seen = (mark: string) => promptsSeen.some(p => p.includes(mark))
      for (let i = 0; i < 100 && !seen('HOLD_TURN one'); i++) await Bun.sleep(100)
      // Typed during the turn, it waits as queued; "Send now" runs it without waiting for the turn.
      await input.fill('NOW_QUEUED')
      await input.press('Enter')
      const queued = page.locator('.main .msg.user.queued', { hasText: 'NOW_QUEUED' })
      await queued.waitFor({ timeout: 10_000 })
      const started = Date.now()
      await page.locator('.queued-now').getByRole('button', { name: 'Send now' }).click()
      await queued.waitFor({ state: 'detached', timeout: 15_000 })
      await page.locator('.main .msg.user:not(.queued)', { hasText: 'NOW_QUEUED' }).waitFor()
      for (let i = 0; i < 100 && !seen('NOW_QUEUED'); i++) await Bun.sleep(100)
      expect(seen('NOW_QUEUED')).toBe(true)
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(await page.locator('.main .msg', { hasText: 'HELD_DONE' }).count()).toBe(0)
      await page.locator('.main .composer .send').waitFor()

      // ctrl+enter with text does the same in one step.
      for (let i = 0; i < 100 && (await page.locator('.main .status-line, .main .stop').count()) > 0; i++) await Bun.sleep(100)
      await input.fill('HOLD_TURN two')
      await input.press('Enter')
      for (let i = 0; i < 100 && !seen('HOLD_TURN two'); i++) await Bun.sleep(100)
      await input.fill('NOW_CTRL')
      await input.press('Control+Enter')
      for (let i = 0; i < 150 && !seen('NOW_CTRL'); i++) await Bun.sleep(100)
      expect(seen('NOW_CTRL')).toBe(true)
      await page.locator('.main .msg.user:not(.queued)', { hasText: 'NOW_CTRL' }).waitFor({ timeout: 15_000 })
      expect(await page.locator('.main .msg', { hasText: 'HELD_DONE' }).count()).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('@s several tasks at once from the coordinator box, and a task box @s the coordinator', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('Multi project')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.getByRole('button', { name: 'Create project' }).click()
      try {
        await page.locator('#projview .pv-head b', { hasText: 'Multi project' }).waitFor({ timeout: 30_000 })
      } catch (e) {
        await page.screenshot({ path: '/tmp/claude-0/multi-fail.png' })
        throw new Error(`page errors: ${errors.join(' | ')}`)
        throw e
      }
      const chat = page.locator('.pv-chat')
      const chatInput = chat.getByLabel('Message', { exact: true })
      await chatInput.fill('please DISPATCH_MULTI')
      await chatInput.press('Enter')
      const side = page.locator('.pv-side')
      const cardOf = (title: string) => side.locator('.pjlist .pjcard', { has: page.locator('.tt', { hasText: new RegExp(`^${title}$`) }) })
      await cardOf('MultiA').waitFor({ timeout: 60_000 })
      await cardOf('MultiB').waitFor({ timeout: 60_000 })

      // Two @ picks make two chips; a picked target drops out of the menu.
      await chatInput.fill('@MultiA')
      await chat.getByRole('option', { name: /MultiA/ }).first().click()
      await chatInput.fill('@Multi')
      expect(await chat.getByRole('option', { name: /MultiA/ }).count()).toBe(0)
      await chat.getByRole('option', { name: /MultiB/ }).first().click()
      expect(await chat.locator('.to-chip').count()).toBe(2)
      await chatInput.fill('MULTI_NOTE for both')
      await chatInput.press('Enter')
      // Both picks got it; the chips are gone.
      expect(await chat.locator('.to-chip').count()).toBe(0)
      await showing(side.getByText('MULTI_A_SAW_NOTE').waitFor({ timeout: 60_000 }), side)
      await side.locator('.pv-crumb button').click()
      await cardOf('MultiB').click()
      await showing(side.locator('.msg.user', { hasText: 'MULTI_NOTE for both' }).first().waitFor({ timeout: 30_000 }), side)
      await showing(side.getByText('MULTI_B_SAW_NOTE').waitFor({ timeout: 60_000 }), side)

      // A task box @s the coordinator: its message goes to the coordinator's chat.
      const taskInput = side.getByLabel('Message', { exact: true })
      await taskInput.fill('@Coord')
      await side.getByRole('option', { name: /Coordinator/ }).first().click()
      expect(await side.locator('.to-chip').count()).toBe(1)
      await taskInput.fill('TASK_NOTE from MultiB')
      await taskInput.press('Enter')
      await chat.locator('.msg.user', { hasText: 'TASK_NOTE from MultiB' }).first().waitFor({ timeout: 30_000 })
      await chat.getByText('COORD_SAW_TASK_NOTE').waitFor({ timeout: 60_000 })
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 240_000)

  it('shares the ↑ history with the CLI: its prompts come back, and what the page sends is added', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US' })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      const historyFile = join(home, '.claude', 'history.jsonl')
      const project = realpathSync(workspace).normalize('NFC')
      // A prompt typed in the CLI in this folder, and one in another folder.
      const cliEntry = (display: string, dir: string) =>
        `${JSON.stringify({ display, pastedContents: {}, timestamp: Date.now(), project: dir, sessionId: 'cli-session' })}\n`
      writeFileSync(historyFile, (existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '') + cliEntry('OTHER_DIR_PROMPT', home) + cliEntry('CLI_PROMPT_MARK', project))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      const input = page.getByLabel('Message', { exact: true })
      await input.click()
      // The folder's history loads after mount; ↑ before it arrives leaves the box empty.
      for (let i = 0; i < 50 && (await input.inputValue()) !== 'CLI_PROMPT_MARK'; i++) {
        await page.waitForTimeout(100)
        await input.press('ArrowUp')
      }
      expect(await input.inputValue()).toBe('CLI_PROMPT_MARK')
      await input.press('ArrowDown')
      expect(await input.inputValue()).toBe('')

      await input.fill('WEB_HIST_MARK hi')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').first().waitFor({ timeout: 30_000 })
      const added = async () =>
        readFileSync(historyFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l) as { display: string; project: string; sessionId?: string })
          .find(e => e.display === 'WEB_HIST_MARK hi')
      for (let i = 0; i < 50 && !(await added()); i++) await Bun.sleep(100)
      expect(await added()).toMatchObject({ project })
      // In the chat: its own prompt first, then the folder's history; never another folder's.
      const chatInput = page.locator('.main').getByLabel('Message', { exact: true })
      await chatInput.click()
      await chatInput.press('ArrowUp')
      expect(await chatInput.inputValue()).toBe('WEB_HIST_MARK hi')
      await chatInput.press('ArrowUp')
      expect(await chatInput.inputValue()).toBe('CLI_PROMPT_MARK')
      for (let i = 0; i < 100; i++) {
        await chatInput.press('ArrowUp')
        expect(await chatInput.inputValue()).not.toBe('OTHER_DIR_PROMPT')
      }
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('moves a session into a project, which lists and opens it, also after a reload', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"])
      .stdout.toString()
      .trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      await page.goto(signInUrl)
      await page.locator('.wl-hi').waitFor()
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      const dialog = page.locator('.dialog')
      await dialog.locator('#pj-name').fill('Move target')
      await dialog.locator('#pj-path').fill(workspace)
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await page.locator('#projview .pv-head b', { hasText: 'Move target' }).waitFor({ timeout: 30_000 })

      await page.getByRole('button', { name: 'New session' }).first().click()
      const input = page.getByLabel('Message', { exact: true })
      await input.fill('MOVE_ME please')
      await input.press('Enter')
      await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
      // A new session is listed under its id until the list reloads with the prompt as its title.
      await page.reload()
      const title = 'MOVE_ME'
      const row = page.locator('#sessions .history .sess', { hasText: title })
      await showing(row.waitFor({ timeout: 15_000 }), page.locator('#sessions'))

      // Move it from the right-click menu's submenu: it leaves the lists, search still finds it.
      await row.click({ button: 'right' })
      await page.locator('.ctxmenu').getByRole('menuitem', { name: /Move to project/ }).click()
      await page.locator('.ctxmenu').getByRole('button', { name: 'Move target' }).click()
      await row.waitFor({ state: 'detached', timeout: 15_000 })
      await page.getByLabel('Search sessions').fill(title)
      await row.waitFor({ timeout: 15_000 })
      await page.getByLabel('Search sessions').fill('')

      // The project lists it and opens it as the chat it is, also after a reload.
      for (const reload of [false, true]) {
        if (reload) await page.reload()
        await page.locator('.pjrow', { hasText: 'Move target' }).click()
        const moved = page.locator('.pv-side .pjlist .pjcard', { hasText: title })
        await showing(moved.waitFor({ timeout: 30_000 }), page.locator('.pv-side'))
        expect(await moved.locator('.sm').textContent()).toBe('Moved in from a session')
        await moved.click()
        await page.locator('.feed').getByText('Hello from the fake model').waitFor({ timeout: 30_000 })
        expect(await page.locator('#projview').isVisible()).toBe(false)
      }
      expect(errors).toEqual([])
      await page.evaluate(async () => {
        for (const s of (await (await fetch('/api/sessions')).json()) as { id: string }[]) {
          await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
        }
      })
    } finally {
      await browser.close()
    }
  }, 120_000)

  it.skipIf(process.platform === 'win32')('shuts down on SIGTERM and removes the lock', async () => {
    web.kill('SIGTERM')
    expect(await web.exited).toBe(143)
    expect(existsSync(join(home, '.claude', 'web.lock'))).toBe(false)
  }, 30_000)
})

// Account menu → Auth submenu → API key dialog against the real credential
// store and settings, in a HOME of its own so the suite above is untouched.
// On macOS the key goes to the login Keychain, which a temporary HOME does not isolate.
describe.skipIf(!binary || process.platform === 'darwin')('claude web account (built binary)', () => {
  const FAKE_KEY = 'sk-ant-api03-WEBTEST_fake_key_0123456789abcdefWXYZ'
  let api: ReturnType<typeof Bun.serve>
  let web: ReturnType<typeof Bun.spawn>
  let signInUrl = ''
  let home = ''
  const keysSeen: string[] = []

  beforeAll(async () => {
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({})
        keysSeen.push(req.headers.get('x-api-key') ?? '')
        return new Response(sse([{ type: 'text', text: 'KEY_OK' }], 'end_turn'), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'web-bin-acct-')))
    mkdirSync(join(home, 'workspace'))
    web = Bun.spawn([binary!, 'web', '--no-open', '--port', '0', '--workspace', join(home, 'workspace')], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        ...windowsHome(home),
        IS_SANDBOX: '1',
        // Replaced from the page; the new key has to win over this one.
        ANTHROPIC_API_KEY: 'sk-ant-env-placeholder-0000',
        // Not a descriptor: keeps a host's token file (/home/claude/.claude/remote) from signing this server in.
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: 'none',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
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

  const globalConfig = () =>
    JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { primaryApiKey?: string }

  it('sets an API key and base URL from the Auth submenu, uses them, then signs out', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"]).stdout.toString().trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      const page = await (await browser.newContext({ locale: 'en-US' })).newPage()
      const errors: string[] = []
      page.on('pageerror', (e: Error) => errors.push(e.message))
      const responses: Promise<string>[] = []
      page.on('response', (res: { url: () => string; text: () => Promise<string> }) => {
        if (res.url().includes('/api/account')) responses.push(res.text().catch(() => ''))
      })
      await page.goto(signInUrl)
      const card = page.locator('#acct-btn')
      await card.getByText('API User').waitFor({ timeout: 15_000 })
      expect(await card.locator('.avatar').textContent()).toBe('A')
      expect(await card.locator('div').textContent()).toBe('API User')

      await card.click()
      const menu = page.locator('#acct-menu')
      expect(await menu.locator('.ah').textContent()).toContain('API UserAnthropic API key · pay as you go')
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual([
        expect.stringContaining('Auth'),
        expect.stringContaining('Settings'),
        expect.stringContaining('Stats'),
        expect.stringContaining('Shortcuts'),
        expect.stringContaining('Sign out'),
      ])
      await menu.getByRole('menuitem', { name: /Auth/ }).click()
      const auth = page.locator('#auth-menu')
      await auth.getByText('Switch auth').waitFor()
      const anthropicRow = auth.getByRole('menuitemradio', { name: /Anthropic API key/ })
      expect(await anthropicRow.getAttribute('aria-checked')).toBe('true')
      expect(await anthropicRow.textContent()).toContain('Saved ····0000 · api.anthropic.com')
      expect(await auth.getByRole('menuitemradio', { name: /OpenAI API key/ }).textContent()).toContain('Not set')
      await auth.getByRole('button', { name: 'Edit Anthropic API key' }).click()

      const dialog = page.getByRole('dialog', { name: 'API key' })
      const base = `http://127.0.0.1:${api.port}`
      expect(await dialog.getByRole('radio', { name: 'Anthropic' }).getAttribute('aria-checked')).toBe('true')
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('ak-key')
      await dialog.getByLabel('API key').fill(FAKE_KEY)
      await dialog.getByLabel('Base URL').fill('ftp://nope.example')
      await dialog.getByRole('button', { name: 'Save and use' }).click()
      await dialog.getByText('Base URL must start with http:// or https://').waitFor()
      expect(await dialog.getByLabel('Base URL').getAttribute('aria-invalid')).toBe('true')
      await dialog.getByLabel('Base URL').fill(base)
      await dialog.getByRole('button', { name: 'Save and use' }).click()
      await page.getByText('Saved, now using Anthropic API key').waitFor()
      await dialog.waitFor({ state: 'detached' })
      await card.click()
      await menu.getByRole('menuitem', { name: /Auth/ }).click()
      expect(await auth.getByRole('menuitemradio', { name: /Anthropic API key/ }).textContent()).toContain(
        `Saved ····WXYZ · 127.0.0.1:${api.port}`,
      )
      await page.keyboard.press('Escape')

      // The TUI's stores: settings `env` and the global config key (no keychain on Linux).
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
        env?: Record<string, string>
      }
      expect(settings.env?.ANTHROPIC_BASE_URL).toBe(base)
      expect(globalConfig().primaryApiKey).toBe(FAKE_KEY)
      expect((await Promise.all(responses)).join('\n')).not.toContain(FAKE_KEY)
      expect(await page.content()).not.toContain(FAKE_KEY)

      // A new session uses the stored key against the new base URL.
      const input = page.getByLabel('Message', { exact: true })
      await input.fill('hello key')
      await input.press('Enter')
      await page.getByText('KEY_OK').waitFor({ timeout: 30_000 })
      // Cloud containers keep an OAuth token at a fixed path that `claude -p`
      // prefers over a /login key (src/utils/authFileDescriptor.ts); elsewhere
      // the stored key is what goes out.
      if (!existsSync('/home/claude/.claude/remote/.oauth_token')) expect(keysSeen.at(-1)).toBe(FAKE_KEY)

      await card.click()
      await menu.getByRole('menuitem', { name: /Sign out/ }).click()
      await card.getByText('Signed out').waitFor()
      await page.getByText('Not signed in').waitFor()
      expect(globalConfig().primaryApiKey).toBeUndefined()
      expect(await input.isDisabled()).toBe(true)
      expect(await input.getAttribute('placeholder')).toBe('Sign in to send messages')
      expect(await page.getByRole('button', { name: 'Send' }).isDisabled()).toBe(true)
      await page.getByRole('button', { name: '+ New session' }).click()
      const startInput = page.getByLabel('Message', { exact: true })
      await page.getByText('Not signed in').waitFor()
      expect(await startInput.isDisabled()).toBe(true)
      expect(await startInput.getAttribute('placeholder')).toBe('Sign in to send messages')
      expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  }, 90_000)

  it('keeps the login-waiting card and its sign-in link inside the viewport', async () => {
    const playwrightPath = Bun.spawnSync(['node', '-p', "require.resolve('playwright')"]).stdout.toString().trim()
    const { chromium } = await import(playwrightPath)
    const browser = await chromium.launch()
    try {
      for (const provider of ['anthropic', 'openai'])
        for (const [width, height] of [
          [1280, 800],
          [390, 844],
        ]) {
          const page = await (await browser.newContext({ locale: 'en-US', viewport: { width, height } })).newPage()
          await page.goto(signInUrl)
          await page.waitForSelector('#acct-btn', { state: 'attached' })
          const started = await page.evaluate(
            (p: string) =>
              fetch('/api/account/oauth', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: p }),
              }).then(r => r.status),
            provider,
          )
          expect(started).toBe(200)
          try {
            await page.reload()
            await page.waitForSelector('#gate .glink')
            const box = await page.evaluate(() => {
              const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect()
              const gate = rect('#gate')
              const link = rect('#gate .glink')
              const input = rect('.wl-box')
              return {
                vw: innerWidth,
                scrollX: document.documentElement.scrollWidth > innerWidth,
                gate: [gate.left, gate.right],
                link: [link.left, link.right],
                input: [input.left, input.right],
              }
            })
            const at = `${provider} ${width}px: ${JSON.stringify(box)}`
            expect(box.scrollX, at).toBe(false)
            expect(box.gate[0], at).toBeGreaterThanOrEqual(0)
            expect(box.gate[1], at).toBeLessThanOrEqual(box.vw)
            expect(box.link[1], at).toBeLessThanOrEqual(box.gate[1])
            // Same column as the message box under it.
            expect(Math.abs(box.gate[0] - box.input[0]), at).toBeLessThanOrEqual(1)
            expect(Math.abs(box.gate[1] - box.input[1]), at).toBeLessThanOrEqual(1)
          } finally {
            await page.evaluate(() => fetch('/api/account/oauth', { method: 'DELETE' }))
            await page.context().close()
          }
        }
    } finally {
      await browser.close()
    }
  }, 90_000)
})
