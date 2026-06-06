#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const projectRoot = resolve(import.meta.dirname, '..')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const localBinary = process.env.LOCAL_CLAUDE_BINARY ?? process.execPath
const localArgs = process.env.LOCAL_CLAUDE_BINARY ? [] : [resolve(projectRoot, 'dist', 'cli.js')]
const outputRoot = resolve(projectRoot, '.claude', 'workflow-tmux-compatibility')
const width = process.env.WORKFLOW_TMUX_COLUMNS ?? '120'
const height = process.env.WORKFLOW_TMUX_ROWS ?? '36'
const waitMs = Number(process.env.WORKFLOW_TMUX_WAIT_MS ?? '1200')
const isolateConfig = process.env.WORKFLOW_TMUX_ISOLATE_CONFIG === '1'
const workflowName = 'tmux-compat-probe'
const workflowBody = `export const meta = {
  name: 'tmux-compat-probe',
  description: 'Interactive tmux compatibility workflow probe.',
  phases: [{ title: 'Wait', detail: 'Ask an agent to wait so /workflows exposes a running task' }],
}
phase('Wait')
await agent('Wait for 20 seconds, then reply exactly: tmux compatibility probe done', { label: 'wait' })
`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trimEnd()
}

function tmux(args) {
  return run('tmux', args)
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function normalizeText(value) {
  return stripAnsi(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/g, '')
}

function envArgs(env) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
}

function hasPermissionPrompt(text) {
  return /(?:Use skill "tmux-compat-probe"\?|Run a dynamic workflow\?|Do you want to proceed\?|Yes, run it|❯\s*1\.\s*Yes)/.test(text)
}

function hasLaunchEvidence(text) {
  return /(?:Running in background|Launched the .*workflow|Run ID:\s*wf_|Waiting for \d+ dynamic workflow|Dynamic workflow requested)/.test(text)
}

function hasWorkflowList(text) {
  return /(?:Dynamic workflows|tmux-compat-probe|Interactive tmux compatibility workflow probe)/.test(text)
}

function hasRunningDetailText(text) {
  return /╭ (?:Phases|Wait)/.test(text) && /(?:↑↓ select|↑↓ agent|x stop|p pause|esc back|s save)/.test(text)
}

function hasPauseEvidence(text) {
  return /(?:paused|Workflow paused|resumeFromRunId|Resume the paused workflow|p pause)/i.test(text)
}

async function delay(ms) {
  await new Promise(resolveWait => setTimeout(resolveWait, ms))
}

async function writeFixture(cwd) {
  await writeFile(join(cwd, 'package.json'), '{"private":true}\n')
  const workflowDir = join(cwd, '.claude', 'workflows')
  await mkdir(workflowDir, { recursive: true })
  await writeFile(join(workflowDir, `${workflowName}.js`), workflowBody)
}

async function probeExecutor({ label, command, args }) {
  const session = `workflow-tmux-${label}-${process.pid}`
  const executorRoot = join(outputRoot, label)
  const cwd = join(executorRoot, 'cwd')
  const home = join(executorRoot, 'home')
  const config = join(executorRoot, 'config')
  await rm(executorRoot, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  await writeFixture(cwd)
  if (isolateConfig) {
    await mkdir(home, { recursive: true })
    await mkdir(config, { recursive: true })
  }

  const env = {
    ...process.env,
    ...(isolateConfig ? { HOME: home, CLAUDE_CONFIG_DIR: config } : {}),
    CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS',
    CLAUDE_CODE_WORKFLOWS: '1',
    NO_COLOR: '1',
  }
  const fullCommand = [shellQuote(command), ...args.map(shellQuote)].join(' ')
  const captures = {}
  let passed = false
  let blocker = 'unknown'

  async function capture(name) {
    const visibleAnsi = tmux(['capture-pane', '-e', '-p', '-t', session])
    const historyAnsi = tmux(['capture-pane', '-e', '-p', '-S', '-', '-t', session])
    const visibleText = normalizeText(visibleAnsi)
    const historyText = normalizeText(historyAnsi)
    await writeFile(join(executorRoot, `${name}.ansi`), visibleAnsi)
    await writeFile(join(executorRoot, `${name}.txt`), `${visibleText}\n`)
    await writeFile(join(executorRoot, `${name}.history.ansi`), historyAnsi)
    await writeFile(join(executorRoot, `${name}.history.txt`), `${historyText}\n`)
    captures[name] = join(executorRoot, `${name}.txt`)
    return visibleText
  }

  async function send(keys, wait = waitMs) {
    tmux(['send-keys', '-t', session, ...keys])
    await delay(wait)
  }

  async function paste(value, wait = waitMs) {
    tmux(['set-buffer', '-b', `${session}-paste`, value])
    tmux(['paste-buffer', '-b', `${session}-paste`, '-t', session])
    await delay(wait)
  }

  async function acceptPrompts(prefix, attempts = 12) {
    let latest = ''
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await capture(`${prefix}-${attempt}`)
      if (!hasPermissionPrompt(latest)) return latest
      await send(['Enter'], 1500)
    }
    return latest
  }

  try {
    tmux([
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      width,
      '-y',
      height,
      '-c',
      cwd,
      'env',
      ...envArgs(env),
      'sh',
      '-lc',
      fullCommand,
    ])
    await delay(900)
    for (const key of ['Enter', 'Enter', 'Enter', 'Enter']) {
      await send([key], 300)
    }
    await capture('startup')

    await paste(`Workflow({ name: "${workflowName}", args: { source: "tmux", executor: "${label}" } })`, 300)
    await send(['Enter'], 4000)
    const afterInvoke = await acceptPrompts('after-invoke', 16)

    let launchText = afterInvoke
    for (let attempt = 0; attempt < 18 && !hasLaunchEvidence(launchText); attempt += 1) {
      await delay(1000)
      launchText = await acceptPrompts(`launch-wait-${attempt}`, 4)
    }

    await send(['/workflows', 'Enter'], 3000)
    const workflowsList = await acceptPrompts('workflows-list', 4)

    let workflowsDetail = ''
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await send(attempt === 0 ? ['Enter'] : ['Down', 'Enter'], 2200)
      workflowsDetail = await capture(attempt === 0 ? 'workflows-detail' : `workflows-detail-retry-${attempt}`)
      if (hasRunningDetailText(workflowsDetail)) break
      await send(['Escape'], 700)
      await send(['/workflows', 'Enter'], 1500)
    }

    let pauseText = ''
    if (hasRunningDetailText(workflowsDetail)) {
      await send(['p'], 1800)
      pauseText = await capture('after-pause')
    }

    const combined = [afterInvoke, launchText, workflowsList, workflowsDetail, pauseText].join('\n')
    const hasWorkflowRun = hasLaunchEvidence(combined) || /◯\s+tmux-compat-probe/.test(combined)
    const hasList = hasWorkflowList(workflowsList)
    const hasRunningDetail = hasRunningDetailText(workflowsDetail)
    const hasPause = hasPauseEvidence(pauseText)
    blocker = hasRunningDetail
      ? 'captured-running-detail'
      : hasList
        ? 'workflow-list-opened-without-running-detail'
        : hasWorkflowRun
          ? 'workflow-launched-without-list'
          : 'workflow-launch-not-observed'
    const report = {
      label,
      command: [command, ...args].join(' '),
      cwd,
      session,
      hasWorkflowRun,
      hasWorkflowList: hasList,
      hasRunningDetail,
      hasPauseEvidence: hasPause,
      blocker,
      captures,
    }
    await writeFile(join(executorRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    passed = hasWorkflowRun && hasList && hasRunningDetail
    return report
  } finally {
    if (passed || process.env.WORKFLOW_TMUX_KEEP_SESSIONS !== '1') {
      spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
    } else {
      console.error(`${label} tmux workflow probe incomplete; blocker=${blocker}; session=${session}; output=${executorRoot}`)
    }
  }
}

if (!existsSync(officialBinary)) {
  throw new Error(`Official Claude binary not found: ${officialBinary}`)
}
if (!process.env.LOCAL_CLAUDE_BINARY && !existsSync(resolve(projectRoot, 'dist', 'cli.js'))) {
  throw new Error('Local dist/cli.js not found; run CLAUDE_CODE_VERSION=2.1.165-dev pnpm build first')
}

await mkdir(outputRoot, { recursive: true })
const official = await probeExecutor({ label: 'official', command: officialBinary, args: [] })
const local = await probeExecutor({ label: 'local', command: localBinary, args: localArgs })
const report = {
  generatedAt: new Date().toISOString(),
  workflowName,
  officialBinary,
  localCommand: [localBinary, ...localArgs].join(' '),
  terminal: { width: Number(width), height: Number(height) },
  isolateConfig,
  official,
  local,
  parity: {
    bothLaunched: official.hasWorkflowRun && local.hasWorkflowRun,
    bothListed: official.hasWorkflowList && local.hasWorkflowList,
    bothCapturedRunningDetail: official.hasRunningDetail && local.hasRunningDetail,
    bothPauseEvidence: official.hasPauseEvidence && local.hasPauseEvidence,
  },
}
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`workflow tmux compatibility output: ${outputRoot}`)
console.log(`official=${official.blocker}`)
console.log(`local=${local.blocker}`)
console.log(`bothCapturedRunningDetail=${report.parity.bothCapturedRunningDetail}`)
if (!report.parity.bothCapturedRunningDetail) {
  process.exitCode = 1
}
