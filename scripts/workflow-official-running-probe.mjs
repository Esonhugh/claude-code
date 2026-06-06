#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import stripAnsi from 'strip-ansi'

const projectRoot = resolve(import.meta.dirname, '..')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const outputRoot = resolve(projectRoot, '.claude', 'workflow-official-running-probe')
const session = `workflow-official-running-${process.pid}`
const width = process.env.WORKFLOW_PROBE_COLUMNS ?? '120'
const height = process.env.WORKFLOW_PROBE_ROWS ?? '36'
const waitMs = Number(process.env.WORKFLOW_PROBE_WAIT_MS ?? '1200')

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

async function capture(label) {
  const visibleAnsi = tmux(['capture-pane', '-e', '-p', '-t', session])
  const historyAnsi = tmux(['capture-pane', '-e', '-p', '-S', '-', '-t', session])
  const visibleText = normalizeText(visibleAnsi)
  const historyText = normalizeText(historyAnsi)
  await writeFile(join(outputRoot, `${label}.ansi`), visibleAnsi)
  await writeFile(join(outputRoot, `${label}.txt`), `${visibleText}\n`)
  await writeFile(join(outputRoot, `${label}.history.ansi`), historyAnsi)
  await writeFile(join(outputRoot, `${label}.history.txt`), `${historyText}\n`)
  return visibleText
}

async function send(keys, delay = waitMs) {
  tmux(['send-keys', '-t', session, ...keys])
  await new Promise(resolveWait => setTimeout(resolveWait, delay))
}

async function paste(value, delay = waitMs) {
  tmux(['set-buffer', '-b', `${session}-paste`, value])
  tmux(['paste-buffer', '-b', `${session}-paste`, '-t', session])
  await new Promise(resolveWait => setTimeout(resolveWait, delay))
}

function hasRunningDetailText(text) {
  return /╭ (?:Phases|Wait)/.test(text) && /(?:↑↓ select|↑↓ agent|x stop|p pause|esc back|s save)/.test(text)
}

function hasPermissionPrompt(text) {
  return /(?:Use skill "running-probe"\?|Run a dynamic workflow\?|Do you want to proceed\?|Yes, run it)/.test(text)
}

function hasLaunchEvidence(text) {
  return /(?:Running in background|Launched the running-probe workflow|Run ID:\s*wf_|Waiting for \d+ dynamic workflow)/.test(text)
}

async function waitForWorkflowLaunch() {
  let latest = ''
  for (let attempt = 0; attempt < 24; attempt += 1) {
    latest = await capture(`launch-wait-${attempt}`)
    if (hasLaunchEvidence(latest)) return latest
    if (hasPermissionPrompt(latest)) {
      await send(['Enter'], 1800)
    } else {
      await new Promise(resolveWait => setTimeout(resolveWait, 1000))
    }
  }
  return latest
}

if (!existsSync(officialBinary)) {
  throw new Error(`Official Claude binary not found: ${officialBinary}`)
}

await mkdir(outputRoot, { recursive: true })
const cwd = join(outputRoot, 'cwd')
const home = join(outputRoot, 'home')
const config = join(outputRoot, 'config')
await mkdir(join(cwd, '.claude', 'workflows'), { recursive: true })
await mkdir(home, { recursive: true })
await mkdir(config, { recursive: true })
await writeFile(
  join(cwd, '.claude', 'workflows', 'running-probe.js'),
  `export const meta = {
    name: 'running-probe',
    description: 'Slow official running workflow probe.',
    phases: [{ title: 'Wait', detail: 'Ask an agent to wait so /workflows has a running task' }],
  }
  phase('Wait')
  await agent('Wait for 20 seconds, then reply exactly: running probe done', { label: 'wait' })
`,
)

const env = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS',
  CLAUDE_CODE_WORKFLOWS: '1',
  NO_COLOR: '1',
}
const command = [shellQuote(officialBinary)].join(' ')
let passed = false
let blocker = 'unknown'
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
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    'sh',
    '-lc',
    command,
  ])
  await new Promise(resolveWait => setTimeout(resolveWait, 900))
  for (const key of ['Enter', 'Enter', 'Enter', 'Enter']) {
    await send([key], 350)
  }
  await capture('startup')

  await paste('Workflow({ name: "running-probe", args: "tmux official running probe" })', 300)
  await send(['Enter'], 5000)
  const afterInvoke = await capture('after-invoke')
  if (hasPermissionPrompt(afterInvoke)) {
    await send(['Enter'], 1800)
  }
  const afterAccept = await waitForWorkflowLaunch()

  await send(['/workflows', 'Enter'], 3500)
  const workflowsList = await capture('workflows-list')

  let workflowsDetail = ''
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await send(attempt === 0 ? ['Enter'] : ['Down', 'Enter'], 2200)
    workflowsDetail = await capture(attempt === 0 ? 'workflows-detail' : `workflows-detail-retry-${attempt}`)
    if (hasRunningDetailText(workflowsDetail)) break
    await send(['Escape'], 800)
    await send(['/workflows', 'Enter'], 1800)
  }

  const combined = [afterInvoke, afterAccept, workflowsList, workflowsDetail].join('\n')
  const hasWorkflowRun = /◯\s+running-probe|Running in background|Run ID:\s*wf_|Dynamic workflows|Dynamic workflow/.test(combined)
  const hasRunningDetail = hasRunningDetailText(workflowsDetail)
  blocker = hasRunningDetail
    ? 'captured-running-detail'
    : hasWorkflowRun
      ? 'workflow-list-opened-without-detail'
      : 'workflow-ui-not-reached'
  await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify({
    officialBinary,
    cwd,
    hasWorkflowRun,
    hasRunningDetail,
    blocker,
    artifacts: {
      startup: join(outputRoot, 'startup.txt'),
      afterInvoke: join(outputRoot, 'after-invoke.txt'),
      afterAccept: join(outputRoot, 'after-accept.txt'),
      workflowsList: join(outputRoot, 'workflows-list.txt'),
      workflowsDetail: join(outputRoot, 'workflows-detail.txt'),
    },
  }, null, 2)}\n`)
  passed = hasRunningDetail
  if (!passed) {
    throw new Error(`official running workflow detail not captured: ${blocker}`)
  }
  console.log(`official workflow running probe captured evidence: ${outputRoot}`)
} finally {
  if (passed) {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  } else {
    console.error(`official workflow running probe incomplete; blocker=${blocker}; session=${session}; output=${outputRoot}`)
  }
}
