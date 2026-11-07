import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GradeStep, Task } from './tasks'

export type GradeContext = {
  workspace: string
  // Lab tasks: the JSON the lab's check script printed, and how many times the
  // harness saw a side door (docker exec) into the target during the run.
  labCheck?: { ok?: boolean } | null
  labBypass?: number
  leanBin?: string
}

export type StepResult = { step: GradeStep; ok: boolean; detail?: string }

const sh = (cmd: string, cwd: string, timeoutSec = 120) =>
  spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: timeoutSec * 1000 })

const read = (ws: string, f: string) => {
  const p = path.join(ws, f)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

const leanNorm = (s: string) => s.replaceAll(':= by', ':=').split(/\s+/).filter(Boolean).join(' ')

// The original statements and definitions must survive verbatim (modulo
// whitespace) and in order; only `sorry` bodies and the answer defs may change.
export function leanKeepsStatements(original: string, solved: string): boolean {
  const keep = original
    .split('\n')
    .filter(l => l.trim() && l.trim() !== 'sorry' && !/^def (answer|placing)\b/.test(l))
  const body = leanNorm(solved)
  let pos = 0
  for (const line of keep) {
    const at = body.indexOf(leanNorm(line), pos)
    if (at < 0) return false
    pos = at + leanNorm(line).length
  }
  return true
}

function runStep(step: GradeStep, task: Task, ctx: GradeContext): StepResult {
  const ws = ctx.workspace
  switch (step.type) {
    case 'exists':
      return { step, ok: fs.existsSync(path.join(ws, step.path)) }
    case 'regex':
      return { step, ok: new RegExp(step.pattern, step.flags).test(read(ws, step.file)) }
    case 'cmd': {
      const r = sh(step.run, ws, step.timeoutSec)
      return { step, ok: r.status === 0, detail: r.status === 0 ? undefined : `${r.stdout}${r.stderr}`.slice(-400) }
    }
    case 'lean': {
      const src = read(ws, step.file)
      const orig = fs.readFileSync(path.join(task.dir, 'workspace', step.file), 'utf8')
      if (/\b(sorry|admit|axiom|native_decide|set_option)\b/.test(src)) return { step, ok: false, detail: 'forbidden keyword' }
      if (!leanKeepsStatements(orig, src)) return { step, ok: false, detail: 'statements changed' }
      const r = sh(`timeout 120 ${ctx.leanBin ?? 'lean'} ${step.file}`, ws, 130)
      const out = `${r.stdout}${r.stderr}`
      return { step, ok: r.status === 0 && !out.includes('warning'), detail: out.slice(-400) || undefined }
    }
    case 'lab':
      return { step, ok: Boolean(ctx.labCheck?.ok) && !ctx.labBypass, detail: ctx.labBypass ? `side door used ${ctx.labBypass}x` : undefined }
  }
}

export function grade(task: Task, ctx: GradeContext): { ok: boolean; steps: StepResult[] } {
  const steps: StepResult[] = []
  for (const step of task.grade) {
    let r: StepResult
    try {
      r = runStep(step, task, ctx)
    } catch (e) {
      r = { step, ok: false, detail: String(e) }
    }
    steps.push(r)
  }
  return { ok: steps.every(s => s.ok), steps }
}
