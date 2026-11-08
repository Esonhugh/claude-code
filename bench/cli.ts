#!/usr/bin/env bun
// agent-bench: run the same tasks through several coding-agent CLIs and compare
// cache hit rate, tokens and API-equivalent cost per task. See docs/features/agent-bench.md.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { scatterSvg } from './lib/chart'
import { CELLS, type Cell, credentialsFromEnv, selectCells } from './lib/clis'
import { generateVariants, harborTask, IN_CONTAINER_CELLS, readPicks, removeImage, runHarbor } from './lib/harbor'
import { PRICES, PRICES_AS_OF, summarize, type CellSummary } from './lib/metrics'
import { makePlan } from './lib/plan'
import { cliVersion, collectResults, runDir, runOne } from './lib/run'
import { listTasks, selectTasks, type Task } from './lib/tasks'

const USAGE = `usage: bun bench/cli.ts <command> [options]

  list                                   tasks and CLI cells
  plan    --cells a,b --tasks id,type:coding|all --reps 3 --seed 1
  run     --cells a,b --tasks ... --reps 3 --seed 1 --raw DIR [--work DIR] [--port 9600] [--timeout 1800] [--smoke]
  analyze --raw DIR [--by type]          per-run results.json + per-cell summary
  chart   --raw DIR --out DIR [--png]    tokens-vs-hit and cost-vs-hit scatter (light + dark SVG)
  public  (--suite tb2 --task NAME | --picks bench/public/picks-A.txt) --cells fork-claude-key,oracle --reps 3 --raw DIR [--variant seed1108] [--smoke]
  perturb --seed N --out DIR             regenerate perturbed public variants (needs BENCH_TB2_ROOT)

Credentials come only from the environment: CLAUDE_CODE_ORG_KEY (Claude API key cells),
BENCH_CLAUDE_CREDENTIALS (Claude subscription login file), BENCH_CODEX_AUTH (ChatGPT login file).`

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: {
    cells: { type: 'string', default: 'fork-claude' },
    tasks: { type: 'string', default: 'all' },
    reps: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    raw: { type: 'string' },
    work: { type: 'string' },
    out: { type: 'string' },
    port: { type: 'string', default: '9600' },
    timeout: { type: 'string', default: '1800' },
    smoke: { type: 'boolean', default: false },
    png: { type: 'boolean', default: false },
    by: { type: 'string', default: 'all' },
    suite: { type: 'string', default: 'tb2' },
    task: { type: 'string' },
    variant: { type: 'string' },
    picks: { type: 'string' },
  },
})

const need = (v: string | undefined, flag: string) => {
  if (!v) throw new Error(`${flag} is required`)
  return path.resolve(v)
}

const onPath = (bin: string) => spawnSync('bash', ['-c', `command -v ${bin}`]).status === 0

// Fail before the first run, not half way through the matrix.
function preflight(cells: Cell[], tasks: Task[]) {
  const creds = credentialsFromEnv()
  const missing: string[] = []
  for (const c of cells) {
    if (c.side === 'claude-key' && !creds.orgKey) missing.push(`${c.id}: CLAUDE_CODE_ORG_KEY`)
    if (c.side === 'claude' && !creds.claudeCredentialsFile) missing.push(`${c.id}: BENCH_CLAUDE_CREDENTIALS`)
    if (c.side === 'chatgpt' && !creds.codexAuthFile) missing.push(`${c.id}: BENCH_CODEX_AUTH`)
  }
  const needs = new Set(tasks.flatMap(t => t.requires))
  if (needs.has('lean') && !onPath(process.env.BENCH_LEAN_BIN ?? 'lean')) missing.push('lean tasks: lean 4.19.0 on PATH (or BENCH_LEAN_BIN)')
  if (needs.has('docker') && spawnSync('docker', ['info']).status !== 0) missing.push('ssh tasks: a running dockerd and the sshlab:1 image')
  if (needs.has('k3s') && !fs.existsSync('/etc/rancher/k3s/k3s.yaml')) missing.push('k8s tasks: local k3s (/etc/rancher/k3s/k3s.yaml)')
  if (missing.length) throw new Error(`not runnable:\n  ${missing.join('\n  ')}`)
  return creds
}

function table(rows: CellSummary[]) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines = ['| cell | group | model / effort | runs | pass | hit | tokens/task (min–max) | $/task |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const r of rows) {
    const t = r.tokensPerTask
    lines.push(
      `| ${r.cell} | ${r.group} | ${r.model} / ${r.effort} | ${r.runs}${r.enoughRuns ? '' : ' (<3/task)'} | ${pct(r.passRate)} | ${pct(r.hitRate)} | ${(t.mean / 1000).toFixed(1)}k (${(t.min / 1000).toFixed(1)}–${(t.max / 1000).toFixed(1)}k) | ${r.costPerTask ? `$${r.costPerTask.mean.toFixed(3)}` : '—'} |`,
    )
  }
  return lines.join('\n')
}

async function main() {
  const cmd = positionals[0]
  const port = Number(o.port)
  const work = o.work ? path.resolve(o.work) : path.join(os.tmpdir(), 'agent-bench-work')
  switch (cmd) {
    case 'list': {
      for (const t of listTasks()) console.log(`task  ${t.id.padEnd(12)} ${t.type.padEnd(12)} ${t.length.padEnd(5)} ${t.requires.join(',')}`)
      for (const c of CELLS) console.log(`cell  ${c.id.padEnd(16)} ${c.product.padEnd(9)} ${c.side.padEnd(10)} ${c.model}`)
      console.log(`in-container cells for public suites: ${IN_CONTAINER_CELLS.join(', ')}`)
      return
    }
    case 'plan': {
      const plan = makePlan(selectCells(o.cells!).map(c => c.id), selectTasks(o.tasks).map(t => t.id), Number(o.reps), Number(o.seed), { smoke: o.smoke })
      for (const p of plan) console.log(`${p.round}\t${p.task}\t${p.cell}`)
      return
    }
    case 'run': {
      const raw = need(o.raw, '--raw')
      const cells = selectCells(o.cells!)
      const tasks = selectTasks(o.tasks)
      const creds = preflight(cells, tasks)
      const versions = Object.fromEntries(cells.map(c => [c.id, cliVersion(c)]))
      const plan = makePlan(cells.map(c => c.id), tasks.map(t => t.id), Number(o.reps), Number(o.seed), { smoke: o.smoke })
      fs.mkdirSync(raw, { recursive: true })
      fs.appendFileSync(path.join(raw, 'plan.log'), `${new Date().toISOString()} seed=${o.seed} reps=${o.reps} cells=${o.cells} tasks=${o.tasks}${o.smoke ? ' smoke' : ''}\n`)
      for (const [i, p] of plan.entries()) {
        const cell = cells.find(c => c.id === p.cell)!
        const task = tasks.find(t => t.id === p.task)!
        if (fs.existsSync(runDir(raw, p.cell, p.task, p.rep))) {
          console.log(`[${i + 1}/${plan.length}] skip ${p.cell} ${p.task} rep ${p.rep} (already recorded)`)
          continue
        }
        try {
          const r = await runOne(cell, task, p.rep, { rawRoot: raw, workRoot: work, proxyPort: port, creds, timeoutSec: Number(o.timeout), smoke: o.smoke, cliVersion: versions[p.cell], leanBin: process.env.BENCH_LEAN_BIN })
          console.log(`[${i + 1}/${plan.length}] ${p.cell} ${p.task} rep ${p.rep}: ${r.ok ? 'pass' : 'FAIL'} hit=${r.hitRate == null ? '—' : (r.hitRate * 100).toFixed(1) + '%'} tokens=${r.totalTokens} ${r.durationS}s`)
        } catch (e) {
          console.log(`[${i + 1}/${plan.length}] ${p.cell} ${p.task} rep ${p.rep}: infra failure: ${(e as Error).message}`)
        }
      }
      return
    }
    case 'analyze': {
      const raw = need(o.raw, '--raw')
      const results = collectResults(raw)
      fs.writeFileSync(path.join(raw, 'results.json'), JSON.stringify(results, null, 1))
      const summary = summarize(results, o.by === 'type' ? 'type' : 'all')
      fs.writeFileSync(path.join(raw, 'summary.json'), JSON.stringify({ pricesAsOf: PRICES_AS_OF, prices: PRICES, cells: summary }, null, 1))
      console.log(`${results.length} runs (${results.filter(r => r.smoke).length} smoke, excluded from the summary); prices as of ${PRICES_AS_OF}\n`)
      console.log(table(summary))
      return
    }
    case 'chart': {
      const raw = need(o.raw, '--raw')
      const out = need(o.out, '--out')
      const results = collectResults(raw)
      const summaries = summarize(results, 'all')
      const facets = summarize(results, 'type')
      fs.mkdirSync(out, { recursive: true })
      const files: string[] = []
      for (const metric of ['tokens', 'cost'] as const) {
        if (metric === 'cost' && !summaries.some(s => s.costPerTask)) continue
        for (const theme of ['light', 'dark'] as const) {
          const f = path.join(out, `${metric}-vs-hit-${theme}.svg`)
          fs.writeFileSync(f, scatterSvg({ metric, summaries, facets }, theme))
          files.push(f)
        }
      }
      fs.writeFileSync(path.join(out, 'scatter-data.json'), JSON.stringify({ pricesAsOf: PRICES_AS_OF, cells: summaries, byType: facets }, null, 1))
      if (o.png) await toPng(files)
      console.log(files.map(f => path.relative(process.cwd(), f)).join('\n'))
      return
    }
    case 'public': {
      const raw = need(o.raw, '--raw')
      if (!o.task && !o.picks) throw new Error('--task or --picks is required')
      if (Number(o.reps) < 3 && !o.smoke && o.cells !== 'oracle') throw new Error('need at least 3 runs per cell; use --smoke for a quick check')
      const creds = credentialsFromEnv()
      // One task at a time: containers share the host network (ports collide) and SWE-bench Pro images fill the disk.
      const picks = o.picks ? readPicks(path.resolve(o.picks)) : [{ suite: o.suite!, task: o.task! }]
      for (const pick of picks) {
        const t = harborTask(pick.suite, pick.task, o.variant)
        for (let rep = 1; rep <= Number(o.reps); rep++) {
          for (const cell of o.cells!.split(',')) {
            const label = `${pick.suite}/${pick.task}${o.variant ? ` (${o.variant})` : ''} ${cell} rep ${rep}`
            try {
              const r = await runHarbor(t, cell, rep, { rawRoot: raw, workRoot: work, proxyPort: port, creds, smoke: o.smoke })
              console.log(`${label}: ${'reward' in r ? `reward=${r.reward}` : `${r.ok ? 'pass' : 'FAIL'} tokens=${r.totalTokens}`}`)
            } catch (e) {
              console.log(`${label}: ${(e as Error).message.startsWith('exists:') ? 'skip (already recorded)' : `infra failure: ${(e as Error).message}`}`)
            }
          }
        }
        if (pick.suite === 'swebenchpro') removeImage(t)
      }
      return
    }
    case 'perturb': {
      console.log(generateVariants(Number(o.seed), need(o.out, '--out')))
      return
    }
    default:
      console.log(USAGE)
      process.exit(cmd ? 1 : 0)
  }
}

// @2x PNG of each SVG through the preinstalled Playwright Chromium.
async function toPng(files: string[]) {
  let pw: { chromium: { launch(): Promise<any> } } // eslint-disable-line @typescript-eslint/no-explicit-any -- optional, untyped dependency
  try {
    pw = await import('playwright' as string)
  } catch {
    throw new Error('--png needs playwright (not a dependency of this repo); render the SVGs another way')
  }
  const browser = await pw.chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  for (const f of files) {
    const svg = fs.readFileSync(f, 'utf8')
    const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/) ?? []
    await page.setViewportSize({ width: Number(w), height: Number(h) })
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`)
    await page.screenshot({ path: f.replace(/\.svg$/, '.png'), omitBackground: true })
  }
  await browser.close()
}

main().catch(e => {
  console.error((e as Error).message)
  process.exit(1)
})
