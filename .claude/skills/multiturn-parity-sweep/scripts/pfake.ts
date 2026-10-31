// Scripted fake Messages API for the multi-turn sweep.
// Main user turns look like "@@ <nonce> <CMD> [args]"; every main turn ends with "DONE <nonce> ...",
// and every turn woken by a <task-notification> answers "NOTIF <nonce> <n>".
// Subagent prompts: QUICK k | SUBQ | NODEQ | MATE k | WFAGENT
import { appendFileSync } from 'fs'
const LOG = process.env.FAKE_LOG ?? '/tmp/fake-mt.log'
const JL = process.env.FAKE_JSONL ?? LOG + '.jsonl'
const note = (s: string) => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`)
const text = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? (b.content ? text(b.content) : '')).join('\n') : ''
type Tool = { name: string; input: any }
type D = { text?: string; tools?: Tool[] }
const isResultMsg = (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')
const results = (msgs: any[]) => msgs.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result') : [])
const CMD = /^@@ (\S+) ([A-Z_]+)(.*)$/m
const WORK = process.env.WORK ?? '/tmp'
const WF_SCRIPT = `export const meta = { name: 'mt-wf', description: 'multi-turn probe workflow', phases: [{ title: 'Probe' }] }
phase('Probe')
const a = await agent('WFAGENT reply with exactly PONG', { label: 'ponger' })
return { a }
`

const classify = (r: string) => /doesn't want|rejected|denied|not allowed|User declined|permission/i.test(r) ? 'denied:' + r.replace(/\s+/g,' ').slice(0, 60) : /error/i.test(r) ? 'err:' + r.replace(/\s+/g,' ').slice(0, 60) : 'ok'
function decide(body: any): { role: string; d: D; extra?: any } {
  const msgs: any[] = body.messages ?? []
  const first = text(msgs[0]?.content)
  const toolNames: string[] = (body.tools ?? []).map((t: any) => t.name)
  const steps = results(msgs).length
  const lastText = text(msgs[msgs.length - 1]?.content)
  let m: RegExpMatchArray | null

  if (toolNames.length === 0) return { role: 'side', d: { text: 'ok' } }
  // ---- subagents (their first message is the prompt; the main conversation always starts with a command or warm-up)
  if (!/^@@ /m.test(first)) {
    if ((m = first.match(/MATE (\d+)/))) {
      const rid = lastText.match(/"request_id"\s*:\s*"([^"]+)"/) ?? lastText.match(/(shutdown-[\w@.-]+)/)
      if (lastText.includes('shutdown_request') && rid)
        return { role: `mate${m[1]}`, d: { tools: [{ name: 'SendMessage', input: { to: 'team-lead', message: { type: 'shutdown_response', request_id: rid[1], approve: true } } }] } }
      return { role: `mate${m[1]}`, d: { text: `mate${m[1]} idle` } }
    }
    if (/WFAGENT/.test(first)) return { role: 'wfagent', d: { text: 'PONG' } }
    if (/\bSUBQ\b/.test(first)) return { role: 'subq', d: { text: `subq reply ${steps}` } }
    if (/\bNODEQ\b/.test(first)) {
      if (steps === 0) return { role: 'nodeq', d: toolNames.includes('Agent') ? { tools: [{ name: 'Agent', input: { description: 'leaf quick', subagent_type: 'general-purpose', prompt: 'QUICK leaf' } }] } : { text: 'nodeq no Agent tool' } }
      return { role: 'nodeq', d: { text: `nodeq done: ${text(results(msgs).at(-1)?.content ?? '').slice(0, 60)}` } }
    }
    if ((m = first.match(/QUICK (\S+)/))) return { role: `quick${m[1]}`, d: steps === 0 ? { tools: [{ name: 'Bash', input: { command: `echo quick-${m[1]}`, description: 'quick' } }] } : { text: `quick done ${m[1]}` } }
  }

  // ---- main session
  let idx = -1
  const cmdText = (m: any) => typeof m.content === 'string' ? m.content : m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && CMD.test(cmdText(msgs[i]))) { idx = i; break }
  if (idx < 0) return { role: 'main:none', d: { text: 'ok' } }
  const [, nonce, cmd, rest] = [...cmdText(msgs[idx]).matchAll(new RegExp(CMD.source, 'gm'))].at(-1)!
  const args = rest.trim().split(/\s+/).filter(Boolean)
  const tail = msgs.slice(idx + 1)
  const s = results(tail).length
  const role = `main:${cmd}`
  const done = (x = '') => ({ text: `DONE ${nonce} ${x}`.trim() })
  // A turn woken by a background notification (no new command since)
  const last = msgs[msgs.length - 1]
  if (last.role === 'user' && !isResultMsg(last) && idx !== msgs.length - 1 && /task-notification|teammate-message|idle_notification/.test(text(last.content))) {
    const n = (text(tail.filter((x: any) => x.role === 'user').map((x: any) => x.content)).match(/<task-notification>/g) ?? []).length
    return { role: role + ':notif', d: { text: `NOTIF ${nonce} ${n}` }, extra: { notif: text(last.content).slice(0, 2000) } }
  }
  const lastRes = text(results(tail).at(-1)?.content ?? '').slice(0, 400)
  switch (cmd) {
    case 'HELLO': return { role, d: done('hello') }
    case 'ONE_SH': return { role, d: s === 0 ? { tools: [{ name: 'Bash', input: { command: `echo one-${nonce}`, description: 'say one' } }] } : done(lastRes.includes(`one-${nonce}`) ? 'sh-ok' : 'sh-bad') }
    case 'MULTI_SH': {
      const c = ['echo a', 'echo b', 'echo c']
      return { role, d: s < 3 ? { tools: [{ name: 'Bash', input: { command: c[s] + '-' + nonce, description: `say ${s}` } }] } : done('multi-ok') }
    }
    case 'PAR_SH': return { role, d: s === 0 ? { tools: [1, 2, 3].map(i => ({ name: 'Bash', input: { command: `echo par${i}-${nonce}`, description: `par ${i}` } })) } : done(`par ${results(tail).length}`) }
    case 'EDIT_GO': {
      const f = `${WORK}/edit-${nonce}.txt`
      if (s === 0) return { role, d: { tools: [{ name: 'Write', input: { file_path: f, content: 'hello\nworld\n' } }] } }
      if (s === 1) return { role, d: { tools: [{ name: 'Edit', input: { file_path: f, old_string: 'hello', new_string: 'bye' } }] } }
      if (s === 2) return { role, d: { tools: [{ name: 'Read', input: { file_path: f } }] } }
      return { role, d: done(lastRes.includes('bye') ? 'edit-ok' : 'edit-bad') }
    }
    case 'TODO_GO': {
      if (s > 0) return { role, d: done(/error/i.test(lastRes) ? 'todo-bad' : 'todo-ok') }
      if (toolNames.includes('TodoWrite')) return { role, d: { tools: [{ name: 'TodoWrite', input: { todos: ['Design schema', 'Write migration'].map((c, i) => ({ content: c, activeForm: c + 'ing', status: i ? 'pending' : 'in_progress' })) } }] }, extra: { todoTool: 'TodoWrite' } }
      if (toolNames.includes('TaskCreate')) return { role, d: { tools: [{ name: 'TaskCreate', input: { subject: 'Design schema', description: 'design it', activeForm: 'Designing schema' } }, { name: 'TaskCreate', input: { subject: 'Write migration', description: 'write it', activeForm: 'Writing migration' } }] }, extra: { todoTool: 'TaskCreate' } }
      return { role, d: done('todo-none') }
    }
    case 'FGQ': return { role, d: s === 0 ? { tools: [{ name: 'Agent', input: { description: 'fg quick', subagent_type: 'general-purpose', prompt: 'QUICK fg', run_in_background: false } }] } : done(/quick done fg/.test(lastRes) ? 'fg-ok' : 'fg-pending') }
    case 'BGQ': {
      const n = Number(args[0] ?? 2)
      return { role, d: s === 0 ? { tools: Array.from({ length: n }, (_, i) => ({ name: 'Agent', input: { description: `bg quick ${i + 1}`, subagent_type: 'general-purpose', prompt: `QUICK b${i + 1}`, run_in_background: true } })) } : done('bg-spawned') }
    }
    case 'NESTQ': return { role, d: s === 0 ? { tools: [{ name: 'Agent', input: { description: 'nest root', subagent_type: 'general-purpose', prompt: 'NODEQ', run_in_background: true } }] } : done('nest-spawned') }
    case 'BGSH_FIN': return { role, d: s === 0 ? { tools: [{ name: 'Bash', input: { command: `sleep 3; echo BGDONE-${nonce}`, description: 'finite bg', run_in_background: true } }] } : done('bgsh-started') }
    case 'SUB_RES': {
      const id = results(tail).map(b => text(b.content)).join('\n').match(/agentId: (\w[\w-]*)/)?.[1]
      if (s === 0) return { role, d: { tools: [{ name: 'Agent', input: { description: 'sub quick', subagent_type: 'general-purpose', prompt: 'SUBQ', run_in_background: true } }] } }
      if (s === 1) return { role, d: { tools: [{ name: 'Bash', input: { command: 'sleep 4', description: 'pause' } }] } }
      if (s === 2) return { role, d: { tools: [{ name: 'SendMessage', input: { to: id ?? 'missing', message: 'again', summary: 'again' } }] } }
      return { role, d: done(/Resum|resum|queued|sent/i.test(lastRes) ? 'resume-ok' : 'resume-bad ' + lastRes.slice(0, 80)) }
    }
    case 'TEAM_UP': {
      const n = Number(args[0] ?? 2)
      return { role, d: s === 0 ? { tools: Array.from({ length: n }, (_, i) => ({ name: 'Agent', input: { name: `mate${i + 1}`, subagent_type: 'general-purpose', description: `mate ${i + 1}`, prompt: `MATE ${i + 1}` } })) } : done('team-up') }
    }
    case 'TEAM_DOWN': {
      if (s > 0) return { role, d: done('shutdown-sent') }
      return { role, d: { tools: ['mate1', 'mate2'].map(n => ({ name: 'SendMessage', input: { to: n, message: { type: 'shutdown_request', reason: 'multi-turn test' } } })) } }
    }
    case 'WF_GO': {
      if (s > 0) return { role, d: done(/PONG/.test(lastRes) ? 'wf-ok' : /started|launched|running/i.test(lastRes) ? 'wf-started' : 'wf-bad') }
      if (!toolNames.includes('Workflow')) return { role, d: done('wf-none') }
      return { role, d: { tools: [{ name: 'Workflow', input: { script: WF_SCRIPT } }] } }
    }
    case 'SKILL_GO': {
      if (s > 0) return { role, d: done(/SKILLBODY|Launching skill|loaded/i.test(lastRes + text(tail.map((x: any) => x.content))) ? 'skill-ok' : 'skill-bad') }
      return { role, d: { tools: [{ name: 'Skill', input: { skill: 'mt-hello' } }] } }
    }
    case 'PSH': {
      if (s === 0) return { role, d: { tools: [{ name: 'Bash', input: { command: args[0] === 'mk' ? `mkdir -p d-${nonce}` : `touch p-${nonce}.txt`, description: 'make perm file' } }] } }
      return { role, d: done(classify(lastRes)) }
    }
    case 'PWRITE': {
      if (s === 0) return { role, d: { tools: [{ name: 'Write', input: { file_path: `${WORK}/w-${nonce}.txt`, content: 'w\n' } }] } }
      return { role, d: done(classify(lastRes)) }
    }
    case 'PREAD': {
      if (s === 0) return { role, d: { tools: [{ name: 'Read', input: { file_path: `${WORK}/base.txt` } }] } }
      return { role, d: done(lastRes.includes('base') ? 'ok' : classify(lastRes)) }
    }
    case 'ENTER_PLAN': {
      if (s === 0) return { role, d: toolNames.includes('EnterPlanMode') ? { tools: [{ name: 'EnterPlanMode', input: {} }] } : done('no-tool') }
      return { role, d: done(classify(lastRes)) }
    }
    case 'PLAN_EXIT': {
      if (s === 0) return { role, d: { tools: [{ name: 'Write', input: { file_path: `${WORK}/plan-${nonce}.txt`, content: 'x\n' } }] } }
      if (s === 1) return { role, d: toolNames.includes('ExitPlanMode') ? { tools: [{ name: 'ExitPlanMode', input: { plan: `PLAN ${nonce}: write the file` } }] } : done('write:' + classify(lastRes) + ' exit:no-tool') }
      return { role, d: done('exit:' + classify(lastRes)) }
    }
    case 'ENV_READ': return { role, d: s === 0 ? { tools: [{ name: 'Read', input: { file_path: `${WORK}/.env` } }] } : done(/off limits/.test(lastRes) ? 'mod-deny' : 'mod-none') }
    case 'GREP_GO': {
      if (s === 0) {
        const t = toolNames.includes('Grep') ? { name: 'Grep', input: { pattern: 'world', path: WORK } } : { name: 'Bash', input: { command: `grep -rl world ${WORK} --include='*.txt' | head -3`, description: 'search' } }
        return { role, d: { tools: [t] }, extra: { search: t.name } }
      }
      return { role, d: done(/edit-|\.txt/.test(lastRes) ? 'grep-ok' : 'grep-bad') }
    }
  }
  return { role, d: done('unknown') }
}

function sse(d: D, model: string): string {
  const ev = (type: string, data: any) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', { message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  if (d.text !== undefined) {
    out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    out += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: d.text } })
    out += ev('content_block_stop', { index: 0 })
  } else {
    d.tools!.forEach((t, i) => {
      out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2), name: t.name, input: {} } })
      out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } })
      out += ev('content_block_stop', { index: i })
    })
  }
  out += ev('message_delta', { delta: { stop_reason: d.text !== undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
  out += ev('message_stop', {})
  return out
}
let n = 0
Bun.serve({
  port: Number(process.env.PORT ?? 18820),
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 10 })
    if (req.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
      const body = await req.json()
      n++
      const msgs = body.messages ?? []
      if (!body.stream) {
        appendFileSync(JL, JSON.stringify({ n, t: Date.now(), role: 'nonstream', msgs: msgs.length }) + '\n')
        return Response.json({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      }
      const { role, d, extra } = decide(body)
      const sysText = typeof body.system === 'string' ? body.system : text(body.system)
      const lastRes = results(msgs.slice(-3)).map(b => text(b.content).replace(/\s+/g, ' ').slice(0, 300))
      if (process.env.FAKE_DUMP) await Bun.write(`${process.env.FAKE_DUMP}/req-${n}.json`, JSON.stringify(body))
      appendFileSync(JL, JSON.stringify({ n, t: Date.now(), role, msgs: msgs.length, tools: (body.tools ?? []).map((t: any) => t.name), deferred: (body.tools ?? []).filter((t: any) => t.defer_loading).map((t: any) => t.name), sysLen: sysText.length, model: body.model, lastRes, out: d.text ?? d.tools!.map(t => t.name), extra }) + '\n')
      note(`${role} msgs=${msgs.length} ${lastRes.length ? `res=[${lastRes.join(' | ').slice(0, 200)}] ` : ''}-> ${d.text ?? d.tools!.map(t => t.name).join(',')}`)
      return new Response(sse(d, body.model), { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({})
  },
})
console.log('fake-mt up')
