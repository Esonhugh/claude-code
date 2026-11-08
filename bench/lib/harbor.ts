// Public suites in the harbor / Terminal-Bench 2 task format (task.toml,
// instruction.md, environment/Dockerfile, tests/test.sh -> /logs/verifier/reward.txt).
// The task runs in its own image; the agent's model traffic goes through the
// same logging proxy on the host (containers use --network host).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binFor, type Credentials, getCell, secretValues } from './clis'
import { analyzeRun, type RunMeta, type RunResult } from './metrics'
import { ensureMitm, startProxy } from './mitm'
import { readRequests } from './run'
import { scrubSecrets } from './secrets'
import { BENCH_ROOT } from './tasks'

const need = (v: string | undefined, name: string) => {
  if (!v) throw new Error(`set ${name}`)
  return v
}

// Plan files list one "<suite> <task>" per line; # starts a comment.
export function readPicks(file: string): { suite: string; task: string }[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map(l => {
      const [suite, task] = l.split(/\s+/)
      return { suite, task }
    })
}

// SWE-bench Pro images are 2–5 GB: drop each one after its task is done.
export function removeImage(t: HarborTask) {
  const toml = fs.readFileSync(path.join(t.dir, 'task.toml'), 'utf8')
  const image = tomlValue(toml, 'environment', 'docker_image') ?? tomlValue(toml, null, 'docker_image') ?? `bench/${t.suite}-${t.task}`.toLowerCase()
  docker(['rmi', '-f', image])
  docker(['builder', 'prune', '-f'])
}

export const PUBLIC_DIR = path.join(BENCH_ROOT, 'public')
export const IN_CONTAINER_CELLS = ['fork-claude', 'fork-claude-key', 'fork-openai', 'oracle']

export type HarborTask = { suite: string; task: string; dir: string; variantDir?: string }

// Upstream sources are not vendored: BENCH_HARBOR_ROOT is a checkout of
// harbor-datasets (datasets/<suite>/<task>); BENCH_TB2_ROOT one of Terminal-Bench 2.
export function harborTask(suite: string, task: string, variant: string | undefined, env = process.env): HarborTask {
  const root = suite === 'tb2' ? env.BENCH_TB2_ROOT : env.BENCH_HARBOR_ROOT && path.join(env.BENCH_HARBOR_ROOT, 'datasets', suite)
  if (!root) throw new Error(suite === 'tb2' ? 'set BENCH_TB2_ROOT' : 'set BENCH_HARBOR_ROOT')
  const dir = path.join(root, task)
  if (!fs.existsSync(path.join(dir, 'task.toml'))) throw new Error(`no task.toml in ${dir}`)
  const variantDir = variant ? path.join(PUBLIC_DIR, 'perturb', variant, suite, task) : undefined
  if (variantDir && !fs.existsSync(variantDir)) throw new Error(`no perturbed variant ${variantDir}`)
  return { suite, task, dir, variantDir }
}

// Tiny TOML reader for the keys we need: [section] key = "string" | number.
export function tomlValue(src: string, section: string | null, key: string): string | undefined {
  let cur: string | null = null
  for (const line of src.split('\n')) {
    const s = line.trim()
    const sec = s.match(/^\[([^\]]+)\]$/)
    if (sec) {
      cur = sec[1]
      continue
    }
    const kv = s.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/)
    if (kv && kv[1] === key && cur === section) return kv[2].replace(/^"(.*)"$/, '$1').trim()
  }
  return undefined
}

function docker(args: string[], opts: { input?: string; timeoutSec?: number } = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', input: opts.input, timeout: (opts.timeoutSec ?? 600) * 1000, maxBuffer: 64 << 20 })
}

const sleep = (s: number) => Bun.sleepSync(s * 1000)

// Docker Hub allows ~100 pulls per hour per IP: pull or build with backoff.
function ensureImage(t: HarborTask, log: string): string {
  const toml = fs.readFileSync(path.join(t.dir, 'task.toml'), 'utf8')
  const named = tomlValue(toml, 'environment', 'docker_image') ?? tomlValue(toml, null, 'docker_image')
  const image = named ?? `bench/${t.suite}-${t.task}`.toLowerCase()
  for (let i = 1; i <= 6; i++) {
    if (docker(['image', 'inspect', image]).status === 0) return image
    const proxy = process.env.HTTPS_PROXY ?? ''
    const r = named
      ? docker(['pull', '-q', image], { timeoutSec: 1800 })
      : docker(['build', '-q', '--network', 'host', '--build-arg', `HTTPS_PROXY=${proxy}`, '--build-arg', `https_proxy=${proxy}`, '-t', image, path.join(t.dir, 'environment')], { timeoutSec: 3600 })
    fs.appendFileSync(log, r.stdout + r.stderr)
    if (r.status !== 0) sleep(i * 60)
  }
  throw new Error(`image unavailable: ${image}`)
}

export type HarborOptions = { rawRoot: string; workRoot: string; proxyPort: number; creds: Credentials; smoke?: boolean }

export async function runHarbor(t: HarborTask, cellId: string, rep: number, opts: HarborOptions): Promise<RunResult | { reward: string }> {
  if (!IN_CONTAINER_CELLS.includes(cellId)) throw new Error(`cell ${cellId} cannot run inside task containers; use one of ${IN_CONTAINER_CELLS.join(', ')}`)
  const variant = t.variantDir ? path.basename(path.dirname(path.dirname(t.variantDir))) : ''
  const raw = path.join(opts.rawRoot, t.suite, t.task, `${cellId}${variant ? `-${variant}` : ''}`, `rep-${rep}`)
  if (fs.existsSync(raw)) throw new Error(`exists: ${raw} (raw results are append-only)`)
  fs.mkdirSync(raw, { recursive: true })
  try {
    return await harborExecute(t, cellId, rep, opts, raw, variant)
  } catch (e) {
    const failed = path.join(opts.rawRoot, '_infra-failed', `${t.suite}-${t.task}-${cellId}-${variant}-rep-${rep}-${Date.now()}`)
    fs.mkdirSync(path.dirname(failed), { recursive: true })
    fs.renameSync(raw, failed)
    scrubSecrets(failed, secretValues(opts.creds))
    throw e
  }
}

async function harborExecute(t: HarborTask, cellId: string, rep: number, opts: HarborOptions, raw: string, variant: string): Promise<RunResult | { reward: string }> {
  if (cellId !== 'oracle' && getCell(cellId).side === 'claude-key' && !opts.creds.orgKey) throw new Error('missing credential: CLAUDE_CODE_ORG_KEY')
  const src = t.variantDir ?? t.dir
  const toml = fs.readFileSync(path.join(t.dir, 'task.toml'), 'utf8')
  const agentTimeout = Number(tomlValue(toml, 'agent', 'timeout_sec') ?? 1800)
  const verifyTimeout = Number(tomlValue(toml, 'verifier', 'timeout_sec') ?? 1800)
  const image = ensureImage(t, path.join(raw, 'build.log'))
  const name = `bench-${t.suite}-${t.task}-${cellId}-${variant}-${rep}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 120)
  docker(['rm', '-f', name])
  if (docker(['run', '-d', '--network', 'host', '--entrypoint', 'sleep', '--name', name, image, 'infinity']).status !== 0) throw new Error('docker run failed')
  const mitm = ensureMitm(path.join(opts.workRoot, 'mitm'))
  try {
    const wd = docker(['inspect', '-f', '{{.Config.WorkingDir}}', name]).stdout.trim() || '/app'
    docker(['cp', mitm.bundle, `${name}:/etc/bench-ca.crt`])
    docker(['cp', mitm.bundle, `${name}:/etc/ccr-ca.crt`]) // the name prelude.sh reads
    const upstream = process.env.HTTPS_PROXY ?? ''
    const sysEnv = ['-e', `HTTPS_PROXY=${upstream}`, '-e', `https_proxy=${upstream}`, '-e', 'SSL_CERT_FILE=/etc/bench-ca.crt', '-e', 'REQUESTS_CA_BUNDLE=/etc/bench-ca.crt', '-e', 'PIP_CERT=/etc/bench-ca.crt']
    fs.writeFileSync(path.join(raw, 'prelude.log'), docker(['exec', '-i', ...sysEnv, name, 'sh'], { input: fs.readFileSync(path.join(PUBLIC_DIR, 'prelude.sh'), 'utf8') }).stdout)
    // SWE-bench Pro: keep the full history outside the container while the agent runs (so it cannot read the
    // upstream fix), and bring it back before grading: test.sh checks out the gold tests from the fix commit.
    const bundle = path.join(opts.workRoot, `${name}.bundle`)
    if (t.suite === 'swebenchpro') {
      if (docker(['exec', '-w', wd, name, 'sh', '-c', 'git bundle create /tmp/full.bundle --all >/dev/null 2>&1']).status === 0) {
        docker(['cp', `${name}:/tmp/full.bundle`, bundle])
        docker(['exec', name, 'rm', '-f', '/tmp/full.bundle'])
      }
      fs.writeFileSync(path.join(raw, 'gitscrub.log'), docker(['exec', '-i', name, 'bash'], { input: fs.readFileSync(path.join(PUBLIC_DIR, 'gitscrub.sh'), 'utf8') }).stdout)
    }
    if (t.variantDir && fs.existsSync(path.join(t.variantDir, 'setup.sh'))) {
      const r = docker(['exec', '-i', name, 'bash'], { input: fs.readFileSync(path.join(t.variantDir, 'setup.sh'), 'utf8') })
      fs.writeFileSync(path.join(raw, 'setup.log'), r.stdout + r.stderr)
      if (r.status !== 0) throw new Error('variant setup.sh failed')
    }

    const proxyUrl = `http://127.0.0.1:${opts.proxyPort}`
    const agentEnv = ['-e', `HTTPS_PROXY=${proxyUrl}`, '-e', `https_proxy=${proxyUrl}`, '-e', 'NO_PROXY=127.0.0.1,localhost', '-e', 'NODE_EXTRA_CA_CERTS=/etc/bench-ca.crt', '-e', 'SSL_CERT_FILE=/etc/bench-ca.crt', '-e', 'IS_SANDBOX=1']
    let argv: string[]
    if (cellId === 'oracle') {
      docker(['cp', `${path.join(src, 'solution')}/.`, `${name}:/solution/`])
      argv = ['bash', '/solution/solve.sh']
    } else {
      const cell = getCell(cellId)
      docker(['cp', binFor('fork'), `${name}:/usr/local/bin/claude`])
      docker(['exec', name, 'mkdir', '-p', '/root/.claude', '/root/.codex'])
      const put = (file: string, data: string) => docker(['exec', '-i', name, 'sh', '-c', `umask 077; cat > ${file}`], { input: data })
      put('/root/.claude.json', JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects: { [wd]: { hasTrustDialogAccepted: true } } }))
      put('/root/.claude/settings.json', JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { defaultMode: 'bypassPermissions' } }))
      if (cell.side === 'claude') put('/root/.claude/.credentials.json', fs.readFileSync(opts.creds.claudeCredentialsFile!, 'utf8'))
      if (cell.side === 'chatgpt') {
        put('/root/.codex/auth.json', fs.readFileSync(opts.creds.codexAuthFile!, 'utf8'))
        agentEnv.push('-e', 'CLAUDE_CODE_USE_OPENAI=1', '-e', 'CODEX_HOME=/root/.codex')
      }
      // name only: docker reads the value from this process's environment
      if (cell.side === 'claude-key') agentEnv.push('-e', 'ANTHROPIC_API_KEY')
      argv = ['claude', '-p', '--model', cell.model, '--output-format', 'stream-json', '--verbose', '--disallowedTools', 'WebSearch,WebFetch']
    }

    const proxy = await startProxy(opts.proxyPort, path.join(raw, 'requests.jsonl'), mitm.dir)
    const t0 = Date.now() / 1000
    const a = spawnSync('docker', ['exec', '-i', '-w', wd, ...agentEnv, name, ...argv], {
      input: fs.readFileSync(path.join(src, 'instruction.md'), 'utf8'),
      env: { ...process.env, ANTHROPIC_API_KEY: opts.creds.orgKey ?? '' },
      timeout: agentTimeout * 1000,
      maxBuffer: 256 << 20,
    })
    const t1 = Date.now() / 1000
    proxy.kill()
    fs.writeFileSync(path.join(raw, 'agent.jsonl'), a.stdout ?? '')
    fs.writeFileSync(path.join(raw, 'agent.err'), a.stderr ?? '')

    docker(['exec', name, 'sh', '-c', 'pkill -f "[c]laude -p" 2>/dev/null; rm -rf /solution /root/.claude/.credentials.json /root/.codex/auth.json; mkdir -p /tests /logs/verifier; rm -f /logs/verifier/reward.txt'])
    docker(['cp', `${path.join(src, 'tests')}/.`, `${name}:/tests/`])
    if (fs.existsSync(bundle)) {
      docker(['cp', bundle, `${name}:/tmp/full.bundle`])
      const g = docker(['exec', '-w', wd, name, 'sh', '-c', 'git fetch -q /tmp/full.bundle "+refs/*:refs/restore/*"; rm -f /tmp/full.bundle'])
      fs.appendFileSync(path.join(raw, 'gitscrub.log'), `restore: ${g.status}\n${g.stderr ?? ''}`)
      fs.rmSync(bundle, { force: true })
    }
    const v = docker(['exec', '-w', wd, ...sysEnv, name, 'bash', '/tests/test.sh'], { timeoutSec: verifyTimeout })
    fs.writeFileSync(path.join(raw, 'verifier.log'), (v.stdout ?? '') + (v.stderr ?? ''))
    const reward = docker(['exec', name, 'cat', '/logs/verifier/reward.txt']).stdout.trim() || 'NA'

    const meta: RunMeta & { suite: string; variant: string; reward: string; scrubbed?: string[] } = {
      cell: cellId,
      product: 'fork',
      side: cellId === 'oracle' ? 'none' : getCell(cellId).side,
      task: t.task,
      type: 'public',
      length: 'long',
      rep,
      model: cellId === 'oracle' ? '' : getCell(cellId).model,
      t0,
      t1,
      rc: a.status,
      ok: Number(reward) >= 1,
      suite: t.suite,
      variant,
      reward,
      ...(opts.smoke ? { smoke: true } : {}),
    }
    const scrubbed = scrubSecrets(raw, secretValues(opts.creds))
    if (scrubbed.length) meta.scrubbed = scrubbed
    fs.writeFileSync(path.join(raw, 'meta.json'), JSON.stringify(meta, null, 1))
    if (cellId === 'oracle') return { reward }
    const result = analyzeRun(meta, readRequests(raw))
    fs.writeFileSync(path.join(raw, 'result.json'), JSON.stringify(result, null, 1))
    return result
  } finally {
    fs.rmSync(path.join(opts.workRoot, `${name}.bundle`), { force: true })
    docker(['rm', '-f', name])
  }
}

// Perturbed variants are generated by public/perturb/mkperturb.py from the upstream
// sources; the oracle (reference solution) must pass every variant before use.
// seed 1107: the 4 prototype TB2 tasks (mkperturb.py, writes <out>/<task>);
// seed 1108 and later: the plan A picks (mkperturb2.py, writes <out>/<suite>/<task>, also needs harbor-datasets).
export function generateVariants(seed: number, out: string, env = process.env) {
  if (!env.BENCH_TB2_ROOT) throw new Error('set BENCH_TB2_ROOT')
  const args =
    seed === 1107
      ? [path.join(PUBLIC_DIR, 'perturb', 'mkperturb.py'), env.BENCH_TB2_ROOT, path.join(out, 'tb2'), String(seed)]
      : [path.join(PUBLIC_DIR, 'perturb', 'mkperturb2.py'), env.BENCH_TB2_ROOT, path.join(need(env.BENCH_HARBOR_ROOT, 'BENCH_HARBOR_ROOT'), 'datasets'), out, String(seed)]
  const r = spawnSync('python3', ['-I', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}
