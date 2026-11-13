import fs from 'node:fs'
import path from 'node:path'

export const BENCH_ROOT = path.resolve(import.meta.dir, '..')
export const TASKS_DIR = path.join(BENCH_ROOT, 'tasks')

export const TASK_TYPES = ['office', 'research', 'coding', 'ops', 'troubleshoot', 'lean', 'memory'] as const
export type TaskType = (typeof TASK_TYPES)[number]

export type GradeStep =
  | { type: 'cmd'; run: string; timeoutSec?: number }
  | { type: 'exists'; path: string }
  | { type: 'regex'; file: string; pattern: string; flags?: string }
  | { type: 'lean'; file: string }
  | { type: 'lab' }

export type Task = {
  id: string
  type: TaskType
  length: 'short' | 'long'
  requires: string[]
  lab?: { kind: 'ssh' | 'k8s'; variant: 's' | 'l' }
  grade: GradeStep[]
  // Memory tasks: [script, ...args] run as python3 <task dir>/<script> ...args <memory dir>
  // to fill the project's auto-memory folder before the first session.
  seedMemory?: string[]
  dir: string
  prompt: string
  // Memory tasks: one prompt per fresh session, run in order on the same HOME
  // and workspace (task.json "sessions": ["s1.md", ...]); otherwise [prompt].
  sessions: string[]
}

export function loadTask(id: string, root = TASKS_DIR): Task {
  const dir = path.join(root, id)
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'))
  if (spec.id !== id) throw new Error(`task ${id}: task.json id is ${spec.id}`)
  if (!TASK_TYPES.includes(spec.type)) throw new Error(`task ${id}: unknown type ${spec.type}`)
  if (!Array.isArray(spec.grade) || spec.grade.length === 0) throw new Error(`task ${id}: no grade steps`)
  if (!fs.existsSync(path.join(dir, 'workspace'))) throw new Error(`task ${id}: no workspace/`)
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').trim()
  const sessions: string[] = Array.isArray(spec.sessions) ? spec.sessions.map(read) : [read('prompt.md')]
  return { ...spec, requires: spec.requires ?? [], dir, prompt: sessions[0], sessions }
}

export function listTasks(root = TASKS_DIR): Task[] {
  return fs
    .readdirSync(root)
    .filter(d => fs.existsSync(path.join(root, d, 'task.json')))
    .sort()
    .map(d => loadTask(d, root))
}

export function selectTasks(spec: string | undefined, root = TASKS_DIR): Task[] {
  const all = listTasks(root)
  if (!spec || spec === 'all') return all
  const out: Task[] = []
  for (const name of spec.split(',')) {
    // 'type:coding' picks every task of a type; a bare name is a task id.
    const hit = name.startsWith('type:') ? all.filter(t => t.type === name.slice(5)) : all.filter(t => t.id === name)
    if (!hit.length) throw new Error(`unknown task or type: ${name}`)
    for (const t of hit) if (!out.includes(t)) out.push(t)
  }
  return out
}

// Placeholders a lab fills in before the prompt reaches the agent.
export function renderPrompt(task: Task, vars: Record<string, string>, prompt = task.prompt): string {
  return prompt.replace(/\{([A-Z]+)\}/g, (m, k) => vars[k] ?? m)
}
