import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binFor, type Cell, type Credentials, secretValues } from './clis'
import { grade } from './grade'
import { analyzeRun, type RequestRecord, type RunMeta, type RunResult } from './metrics'
import { ensureMitm, startProxy } from './mitm'
import { scrubSecrets } from './secrets'
import { BENCH_ROOT, renderPrompt, type Task } from './tasks'

export type RunOptions = {
  rawRoot: string // append-only results tree
  workRoot: string // scratch: HOMEs with credentials, workspaces; removed after each run
  proxyPort: number
  creds: Credentials
  timeoutSec?: number
  smoke?: boolean
  cliVersion?: string
  leanBin?: string
}

export const runDir = (rawRoot: string, cell: string, task: string, rep: number) => path.join(rawRoot, cell, task, `rep-${rep}`)

type Lab = { vars: Record<string, string>; down(t0: number, t1: number): number; check(): { ok?: boolean } | null }

function startLab(task: Task, scratch: string, port: number, cell: string, rep: number): Lab | null {
  if (!task.lab) return null
  const dir = path.join(BENCH_ROOT, 'labs', task.lab.kind)
  const v = task.lab.variant
  const param = task.lab.kind === 'ssh' ? String(port - 7000) : `bench-${task.id}-${cell}-${rep}`.toLowerCase()
  const sh = (script: string, ...args: string[]) => spawnSync('bash', [path.join(dir, script), scratch, v, param, ...args], { encoding: 'utf8', timeout: 300_000 })
  const up = sh(`${task.lab.kind}_up.sh`)
  if (up.status !== 0) throw new Error(`lab up failed: ${up.stderr}`)
  return {
    vars: task.lab.kind === 'ssh' ? { PORT: param } : { NS: param },
    down: (t0, t1) => Number(sh(`${task.lab.kind}_down.sh`, String(Math.floor(t0)), String(Math.ceil(t1) + 1)).stdout.trim()) || 0,
    check: () => {
      const r = spawnSync('python3', [path.join(dir, `${task.lab.kind}_check.py`), scratch, v, param], { encoding: 'utf8', timeout: 300_000 })
      try {
        return JSON.parse(r.stdout)
      } catch {
        return null
      }
    },
  }
}

function copyTree(src: string, dst: string, skip: (rel: string) => boolean = () => false) {
  fs.cpSync(src, dst, { recursive: true, filter: s => !skip(path.relative(src, s)) })
}

// exitAfter: some CLIs keep running after their final event (dsh on the ChatGPT
// route holds its WebSocket ~5 min). Once that marker is in stdout, the run is over.
function runAgent(argv: string[], env: Record<string, string>, cwd: string, stdin: string | undefined, out: string, err: string, timeoutSec: number, exitAfter?: string) {
  return new Promise<{ rc: number | null; endedAt?: number }>(resolve => {
    let endedAt: number | undefined
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', fs.openSync(out, 'a'), fs.openSync(err, 'a')],
    })
    if (stdin !== undefined) child.stdin!.end(stdin)
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // the group is already gone
      }
    }
    const timer = setTimeout(killGroup, timeoutSec * 1000)
    const poll = exitAfter
      ? setInterval(() => {
          if (endedAt === undefined && fs.readFileSync(out, 'utf8').includes(exitAfter)) {
            endedAt = Date.now() / 1000
            setTimeout(killGroup, 3000)
          }
        }, 500)
      : undefined
    child.on('error', () => resolve({ rc: null }))
    child.on('exit', code => {
      clearTimeout(timer)
      clearInterval(poll)
      killGroup() // background children left behind by the CLI
      resolve({ rc: endedAt === undefined ? code : 0, endedAt })
    })
  })
}

export async function runOne(cell: Cell, task: Task, rep: number, opts: RunOptions): Promise<RunResult> {
  const raw = runDir(opts.rawRoot, cell.id, task.id, rep)
  if (fs.existsSync(raw)) throw new Error(`exists: ${raw} (raw results are append-only)`)
  fs.mkdirSync(raw, { recursive: true })
  fs.mkdirSync(opts.workRoot, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(opts.workRoot, `${cell.id}-${task.id}-${rep}-`))
  copyTree(path.join(task.dir, 'workspace'), path.join(scratch, 'w'), rel => rel === '.keep')
  fs.mkdirSync(path.join(scratch, 'h'), { recursive: true })

  try {
    return await execute(cell, task, rep, opts, raw, scratch)
  } catch (e) {
    // Infra failure: keep what was written, out of the way of the retry.
    const failed = path.join(opts.rawRoot, '_infra-failed', `${cell.id}-${task.id}-rep-${rep}-${Date.now()}`)
    fs.mkdirSync(path.dirname(failed), { recursive: true })
    fs.renameSync(raw, failed)
    scrubSecrets(failed, secretValues(opts.creds))
    throw e
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

async function execute(cell: Cell, task: Task, rep: number, opts: RunOptions, raw: string, scratch: string): Promise<RunResult> {
  const mitm = ensureMitm(path.join(opts.workRoot, 'mitm'))
  const ws = path.join(scratch, 'w')
  const home = path.join(scratch, 'h')
  let lab: Lab | null = null
  let t0 = Date.now() / 1000
  let t1 = t0
  let rc: number | null = null
  let labBypass = 0
  let labCheck: { ok?: boolean } | null = null
  try {
    lab = startLab(task, scratch, opts.proxyPort, cell.id, rep)
    const prompt = renderPrompt(task, lab?.vars ?? {})
    const ctx = { home, workspace: ws, proxyPort: opts.proxyPort, prompt, creds: opts.creds }
    cell.setupHome(ctx)
    const launch = cell.launch(binFor(cell.product), ctx)
    const proxyUrl = `http://127.0.0.1:${opts.proxyPort}`
    // A clean environment: nothing from the harness leaks in, credentials only where the cell asks for them.
    const env: Record<string, string> = {
      PATH: process.env.BENCH_PATH ?? process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      NODE_EXTRA_CA_CERTS: mitm.bundle,
      SSL_CERT_FILE: mitm.bundle,
      IS_SANDBOX: '1',
      ...launch.env,
    }
    const proxy = await startProxy(opts.proxyPort, path.join(raw, 'requests.jsonl'), mitm.dir)
    t0 = Date.now() / 1000
    try {
      const r = await runAgent(launch.argv, env, ws, launch.stdin, path.join(raw, 'out.jsonl'), path.join(raw, 'err.txt'), opts.timeoutSec ?? 1800, launch.exitAfter)
      rc = r.rc
      t1 = r.endedAt ?? Date.now() / 1000
    } finally {
      t1 = t1 === t0 ? Date.now() / 1000 : t1
      await new Promise(r => setTimeout(r, 1000))
      proxy.kill()
    }
    if (lab) {
      labCheck = lab.check()
      fs.writeFileSync(path.join(raw, 'lab-check.json'), JSON.stringify(labCheck))
    }
  } finally {
    if (lab) labBypass = lab.down(t0, t1)
  }

  const g = grade(task, { workspace: ws, labCheck, labBypass, leanBin: opts.leanBin })
  fs.writeFileSync(path.join(raw, 'grade.json'), JSON.stringify(g, null, 1))
  copyTree(ws, path.join(raw, 'workspace'), rel => rel === 'keys' || rel.startsWith('keys/'))

  const meta: RunMeta & { labBypass?: number; scrubbed?: string[] } = {
    cell: cell.id,
    product: cell.product,
    side: cell.side,
    task: task.id,
    type: task.type,
    length: task.length,
    rep,
    model: cell.model,
    cliVersion: opts.cliVersion,
    t0,
    t1,
    rc,
    ok: g.ok,
    ...(opts.smoke ? { smoke: true } : {}),
    ...(task.lab ? { labBypass } : {}),
  }
  const scrubbed = scrubSecrets(raw, secretValues(opts.creds))
  if (scrubbed.length) meta.scrubbed = scrubbed
  fs.writeFileSync(path.join(raw, 'meta.json'), JSON.stringify(meta, null, 1))
  const result = analyzeRun(meta, readRequests(raw))
  fs.writeFileSync(path.join(raw, 'result.json'), JSON.stringify(result, null, 1))
  return result
}

export function readRequests(raw: string): RequestRecord[] {
  const f = path.join(raw, 'requests.jsonl')
  if (!fs.existsSync(f)) return []
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

// Re-analyze every finished run under a raw tree (graders already ran; only metrics are recomputed).
export function collectResults(rawRoot: string): RunResult[] {
  const out: RunResult[] = []
  const walk = (dir: string, depth: number) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_')) continue
      const p = path.join(dir, e.name)
      if (depth === 2) {
        const m = path.join(p, 'meta.json')
        if (fs.existsSync(m)) out.push(analyzeRun(JSON.parse(fs.readFileSync(m, 'utf8')), readRequests(p)))
      } else walk(p, depth + 1)
    }
  }
  walk(rawRoot, 0)
  return out
}

export function cliVersion(cell: Cell): string | undefined {
  const r = spawnSync(binFor(cell.product), ['--version'], { encoding: 'utf8', timeout: 30_000 })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : undefined
}
