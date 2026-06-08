#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const projectRoot = resolve(import.meta.dirname, '..')
const outputRoot = resolve(projectRoot, '.claude', 'workflow-deep-research-command-probe')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const waitMs = Number(process.env.DEEP_RESEARCH_PROBE_WAIT_MS ?? '120000')
const width = process.env.DEEP_RESEARCH_PROBE_COLUMNS ?? '140'
const height = process.env.DEEP_RESEARCH_PROBE_ROWS ?? '40'
const question = '分析 claude 的 dynamic workflow 设计原理'
const scenarios = [
  {
    key: 'workflows-run-panel',
    prompt: `/workflows run deep-research -- ${question}`,
    expectLaunch: false,
    expectPanel: true,
    description: 'Interactive /workflows run keeps official-compatible /workflows panel behavior instead of launching directly.',
  },
  {
    key: 'deep-research-slash',
    prompt: `/deep-research ${question}`,
    expectLaunch: true,
    expectPanel: false,
    description: 'Bundled /deep-research slash command launches the dynamic workflow through WorkflowTool.',
  },
]

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

function normalize(value) {
  return stripAnsi(value).replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n+$/g, '')
}

function hasPermissionPrompt(text) {
  return /(?:Run a dynamic workflow\?|Do you want to proceed\?|Yes, run it|❯\s*1\.\s*Yes|Accept\s+Decline)/.test(text)
}

function hasExecutionCrash(text) {
  return /Cannot read properties of undefined \(reading 'execution'\)/.test(text)
}

function hasWorkflowToolCall(text) {
  return /(?:WorkflowTool\(Workflow run deep-research\)|Workflow\(dynamic workflow: deep-research\)|Workflow\(Workflow deep-research\))/.test(text)
}

function hasWorkflowLaunchEvidence(text) {
  return /(?:Workflow launched in background\. Task ID:\s*w[a-z0-9-]+|Task ID:\s*w[a-z0-9-]+|Run ID:\s*wf_[a-z0-9-]+|Running in background|\b\d+ background workflow\b|[●✔◯]\s+(?:workflow )?deep-research\s+\d+\/\d+ agents .*\b(?:running|done)\b|◯ deep-research\s+.*\d+\/\d+ agents done)/.test(text)
}

function hasWorkflowPanel(text) {
  return /Dynamic workflows/.test(text) && /(?:No dynamic workflows in this session|Enter to view|↑\/↓ to select|Esc to close)/.test(text)
}

function hasDetailEvidence(text) {
  return (
    (/deep-research/.test(text) && /(?:Enter to view|↑\/↓ to select|\d+\/\d+ agents|\d+\/\d+ agents done|workflow deep-research)/.test(text)) ||
    (/(?:Workflow detail|Controls:|Events:|Runtime:|Phases:|Scope|Search|Fetch|Verify|Synthesize)/.test(text) &&
      /(?:deep-research|\/workflows pause|\/workflows resume|workflow_progress|wf_[a-z0-9-]+)/.test(text))
  )
}

function extractTaskId(text) {
  return text.match(/Task ID:\s*(w[a-z0-9-]+)/)?.[1] ?? text.match(/\.claude\/tasks\/(w[a-z0-9-]+)\.output/)?.[1]
}

async function delay(ms) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

async function probe(label, command, scenario) {
  const session = `deep-research-${scenario.key}-${label}-${process.pid}`
  const outDir = join(outputRoot, scenario.key, label)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const env = {
    ...process.env,
    CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS',
    CLAUDE_CODE_WORKFLOWS: '1',
    NO_COLOR: '1',
  }
  const envArgs = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  const captures = {}

  async function capture(name) {
    const visibleAnsi = tmux(['capture-pane', '-e', '-p', '-t', session])
    const historyAnsi = tmux(['capture-pane', '-e', '-p', '-S', '-', '-t', session])
    const visibleText = normalize(visibleAnsi)
    const historyText = normalize(historyAnsi)
    await writeFile(join(outDir, `${name}.ansi`), visibleAnsi)
    await writeFile(join(outDir, `${name}.txt`), `${visibleText}\n`)
    await writeFile(join(outDir, `${name}.history.ansi`), historyAnsi)
    await writeFile(join(outDir, `${name}.history.txt`), `${historyText}\n`)
    captures[name] = join(outDir, `${name}.history.txt`)
    return historyText
  }

  function send(keys) {
    tmux(['send-keys', '-t', session, ...keys])
  }

  function paste(value) {
    tmux(['set-buffer', '-b', `${session}-prompt`, value])
    tmux(['paste-buffer', '-b', `${session}-prompt`, '-t', session])
  }

  async function acceptPrompts(prefix, attempts = 10) {
    let latest = ''
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await capture(`${prefix}-${attempt}`)
      if (!hasPermissionPrompt(latest)) return latest
      send(['Enter'])
      await delay(1500)
    }
    return latest
  }

  let finalText = ''
  let detailText = ''
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
      projectRoot,
      'env',
      ...envArgs,
      'sh',
      '-lc',
      command,
    ])
    await delay(2500)
    for (const key of ['Enter', 'Enter', 'Escape']) {
      send([key])
      await delay(500)
    }
    await capture('startup')

    paste(scenario.prompt)
    await delay(300)
    send(['Enter'])

    const deadline = Date.now() + (scenario.expectLaunch ? waitMs : Math.min(waitMs, 20000))
    let index = 0
    while (Date.now() < deadline) {
      await delay(3000)
      finalText = await acceptPrompts(`after-command-${index}`, 3)
      if (hasExecutionCrash(finalText)) break
      if (scenario.expectLaunch && hasWorkflowToolCall(finalText) && hasWorkflowLaunchEvidence(finalText)) break
      if (!scenario.expectLaunch && hasWorkflowPanel(finalText)) break
      if (/Request timed out|API Error/.test(finalText)) break
      index += 1
    }

    const taskId = extractTaskId(finalText)
    if (scenario.expectLaunch && hasWorkflowLaunchEvidence(finalText)) {
      send(['Escape'])
      await delay(700)
      paste('/workflows')
      await delay(300)
      send(['Enter'])
      await delay(1800)
      const listText = await capture('detail-list')
      send(['Enter'])
      await delay(2500)
      detailText = await acceptPrompts('detail-enter', 3)
      if (!hasDetailEvidence(detailText) && taskId) {
        send(['Escape'])
        await delay(700)
        paste(`/workflows detail ${taskId}`)
        await delay(300)
        send(['Enter'])
        await delay(1800)
        const taskListText = await capture('detail-task-list')
        send(['Enter'])
        await delay(2500)
        detailText = [detailText, taskListText, await acceptPrompts('detail-task-enter', 3)].join('\n')
      }
      detailText = [listText, detailText].join('\n')
    }

    finalText = [finalText, detailText, await capture('final')].join('\n')
    const report = {
      label,
      command,
      scenario: scenario.key,
      description: scenario.description,
      prompt: scenario.prompt,
      session,
      taskId,
      hasExecutionCrash: hasExecutionCrash(finalText),
      hasWorkflowToolCall: hasWorkflowToolCall(finalText),
      hasWorkflowLaunchEvidence: hasWorkflowLaunchEvidence(finalText),
      hasWorkflowPanel: hasWorkflowPanel(finalText),
      hasWorkflowDetailEvidence: hasDetailEvidence(detailText || finalText),
      hasTimeoutOrApiError: /Request timed out|API Error/.test(finalText),
      outputDir: outDir,
      captures,
    }
    report.hasWorkflowEvidence = scenario.expectLaunch
      ? report.hasWorkflowToolCall && report.hasWorkflowLaunchEvidence && report.hasWorkflowDetailEvidence
      : report.hasWorkflowPanel && !report.hasWorkflowLaunchEvidence
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  }
}

await mkdir(outputRoot, { recursive: true })
const scenarioReports = []
for (const scenario of scenarios) {
  const official = await probe('official', `${shellQuote(officialBinary)} --dangerously-skip-permissions`, scenario)
  const local = await probe('local', 'pnpm start --dangerously-skip-permissions', scenario)
  const parity = scenario.expectLaunch
    ? {
        neitherHasExecutionCrash: !official.hasExecutionCrash && !local.hasExecutionCrash,
        bothUsedWorkflowTool: official.hasWorkflowToolCall && local.hasWorkflowToolCall,
        bothHaveLaunchEvidence: official.hasWorkflowLaunchEvidence && local.hasWorkflowLaunchEvidence,
        bothHaveDetailEvidence: official.hasWorkflowDetailEvidence && local.hasWorkflowDetailEvidence,
        neitherTimedOutOrApiErrored: !official.hasTimeoutOrApiError && !local.hasTimeoutOrApiError,
      }
    : {
        neitherHasExecutionCrash: !official.hasExecutionCrash && !local.hasExecutionCrash,
        bothOpenedWorkflowPanel: official.hasWorkflowPanel && local.hasWorkflowPanel,
        neitherLaunchedWorkflow: !official.hasWorkflowLaunchEvidence && !local.hasWorkflowLaunchEvidence,
        neitherTimedOutOrApiErrored: !official.hasTimeoutOrApiError && !local.hasTimeoutOrApiError,
      }
  const passed = Object.values(parity).every(Boolean)
  scenarioReports.push({ ...scenario, official, local, parity, passed })
}
const report = { waitMs, scenarios: scenarioReports }
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`deep-research command probe output: ${outputRoot}`)
for (const scenario of scenarioReports) {
  console.log(`${scenario.key}: passed=${scenario.passed}`)
  console.log(`  official: workflowEvidence=${scenario.official.hasWorkflowEvidence} panel=${scenario.official.hasWorkflowPanel} toolCall=${scenario.official.hasWorkflowToolCall} launch=${scenario.official.hasWorkflowLaunchEvidence} detail=${scenario.official.hasWorkflowDetailEvidence} executionCrash=${scenario.official.hasExecutionCrash} apiTimeout=${scenario.official.hasTimeoutOrApiError}`)
  console.log(`  local: workflowEvidence=${scenario.local.hasWorkflowEvidence} panel=${scenario.local.hasWorkflowPanel} toolCall=${scenario.local.hasWorkflowToolCall} launch=${scenario.local.hasWorkflowLaunchEvidence} detail=${scenario.local.hasWorkflowDetailEvidence} executionCrash=${scenario.local.hasExecutionCrash} apiTimeout=${scenario.local.hasTimeoutOrApiError}`)
}
if (scenarioReports.some(scenario => !scenario.passed)) {
  process.exitCode = 1
}
