#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const projectRoot = resolve(import.meta.dirname, '..')
const outputRoot = resolve(projectRoot, '.claude', 'workflow-investigate-gate-probe')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const prompt = '/investigate 为什么这个隔离目录的假想测试会超时。不要修改文件，只启动/规划 workflow。'
const waitMs = Number(process.env.INVESTIGATE_GATE_WAIT_MS ?? '45000')
const variants = [
  { name: 'default', env: {} },
  { name: 'recover', env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS', CLAUDE_CODE_WORKFLOWS: '1' } },
  { name: 'tengu', env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS', CLAUDE_CODE_WORKFLOWS: '1', tengu_workflows_enabled: 'true', CLAUDE_CODE_INVESTIGATE_FIRST: '1' } },
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trimEnd()
}
function tmux(args) { return run('tmux', args) }
function shellQuote(value) { return `'${value.replace(/'/g, `'\\''`)}'` }
function normalize(value) { return stripAnsi(value).replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n+$/g, '') }
function hasWorkflow(text) { return /WorkflowTool\(Workflow run investigate\)|Workflow\([^)]*investigate[^)]*\)|workflow investigate|Running in background|\d+ background workflow/.test(text) }
function hasUnknown(text) { return /Unknown command: \/investigate|Unknown skill: investigate/.test(text) }
function hasDetective(text) { return /detective:investigate|Skill\(detective:investigate\)/.test(text) }
async function delay(ms) { await new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }

async function probe(variant) {
  const session = `investigate-gate-${variant.name}-${process.pid}`
  const outDir = join(outputRoot, variant.name)
  const cwd = join(outDir, 'cwd')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'package.json'), '{"private":true}\n')
  const settings = JSON.stringify({ enabledPlugins: { 'detective@Esonhugh-Marketplace': false } })
  const env = { ...process.env, NO_COLOR: '1', ...variant.env }
  const envArgs = Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`)
  async function capture(name) {
    const ansi = tmux(['capture-pane', '-e', '-p', '-S', '-', '-t', session])
    const text = normalize(ansi)
    await writeFile(join(outDir, `${name}.ansi`), ansi)
    await writeFile(join(outDir, `${name}.txt`), `${text}\n`)
    return text
  }
  try {
    tmux(['new-session', '-d', '-s', session, '-x', '140', '-y', '40', '-c', cwd, 'env', ...envArgs, 'sh', '-lc', `${shellQuote(officialBinary)} --dangerously-skip-permissions --settings ${shellQuote(settings)}`])
    await delay(2500)
    for (const key of ['Enter', 'Enter', 'Escape']) { tmux(['send-keys', '-t', session, key]); await delay(500) }
    tmux(['send-keys', '-t', session, 'C-u'])
    await delay(300)
    tmux(['send-keys', '-t', session, '-l', prompt])
    await delay(500)
    tmux(['send-keys', '-t', session, 'Enter'])
    let text = ''
    const deadline = Date.now() + waitMs
    let i = 0
    while (Date.now() < deadline) {
      await delay(3000)
      text = await capture(`after-${i}`)
      if (hasWorkflow(text) || hasUnknown(text) || hasDetective(text) || /Request timed out|API Error|Error:/.test(text)) break
      i += 1
    }
    text = [text, await capture('final')].join('\n')
    const report = { variant: variant.name, env: variant.env, hasWorkflow: hasWorkflow(text), hasUnknown: hasUnknown(text), hasDetective: hasDetective(text), hasTimeoutOrApiError: /Request timed out|API Error/.test(text), outputDir: outDir }
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  }
}

await mkdir(outputRoot, { recursive: true })
const reports = []
for (const variant of variants) reports.push(await probe(variant))
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify({ reports }, null, 2)}\n`)
console.log(`investigate gate probe output: ${outputRoot}`)
for (const r of reports) console.log(`${r.variant}: workflow=${r.hasWorkflow} unknown=${r.hasUnknown} detective=${r.hasDetective} timeout=${r.hasTimeoutOrApiError}`)
if (!reports.some(r => r.hasWorkflow)) process.exitCode = 1
