#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const projectRoot = resolve(import.meta.dirname, '..')
const outputRoot = resolve(projectRoot, '.claude', 'workflow-slash-commands-probe')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const localBinary = process.env.LOCAL_CLAUDE_BINARY ?? process.execPath
const disableDetectiveSettings = JSON.stringify({
  enabledPlugins: { 'detective@Esonhugh-Marketplace': false },
})
const localArgs = process.env.LOCAL_CLAUDE_BINARY ? ['--dangerously-skip-permissions', '--settings', disableDetectiveSettings] : [resolve(projectRoot, 'dist', 'cli.js'), '--dangerously-skip-permissions', '--settings', disableDetectiveSettings]
const waitMs = Number(process.env.WORKFLOW_SLASH_PROBE_WAIT_MS ?? '60000')
const width = process.env.WORKFLOW_SLASH_PROBE_COLUMNS ?? '140'
const height = process.env.WORKFLOW_SLASH_PROBE_ROWS ?? '40'
const scenarios = [
  {
    name: 'deep-research',
    prompt: '/deep-research 分析 Claude Code dynamic workflow 的设计原理，用中文总结；只需要启动 workflow。',
    expectedOfficialWorkflowName: 'deep-research',
    expectedLocalClassification: 'workflow',
  },
  {
    name: 'bugfix',
    prompt: '/bugfix 调查这个隔离目录里一个假想 bug：命令 foo 返回错误。不要修改文件，只启动/规划 workflow。',
    expectedOfficialWorkflowName: 'bugfix',
    expectedLocalClassification: 'non-workflow-response',
  },
  {
    name: 'docs',
    prompt: '/docs 为这个隔离目录的示例 CLI 写文档计划。不要修改文件，只启动/规划 workflow。',
    expectedOfficialWorkflowName: 'docs',
    expectedLocalClassification: 'non-workflow-response',
  },
  {
    name: 'investigate',
    prompt: '/investigate 为什么这个隔离目录的假想测试会超时。不要修改文件，只启动/规划 workflow。',
    expectedOfficialWorkflowName: 'investigate',
    expectedLocalClassification: 'non-workflow-response',
  },
  {
    name: 'dashboard',
    prompt: '/dashboard 为这个隔离目录的假想 metrics 设计 dashboard。不要修改文件，只启动/规划 workflow。',
    expectedOfficialWorkflowName: 'dashboard',
    expectedLocalClassification: 'non-workflow-response',
  },
  {
    name: 'autopilot',
    prompt: '/autopilot 调查这个隔离目录并提出一个最小改进计划。不要修改文件，只启动/规划 workflow。',
    expectedOfficialWorkflowName: 'autopilot',
    expectedLocalClassification: 'non-workflow-response',
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
  return /(?:Run a dynamic workflow\?|Do you want to proceed\?|Yes, run it|❯\s*1\.\s*Yes|Accept\s+Decline|Use skill "[^"]+"\?)/.test(text)
}

function hasWorkflowToolCall(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:WorkflowTool\\(Workflow run ${escaped}\\)|Workflow\\(dynamic workflow: ${escaped}\\)|Workflow\\(Workflow ${escaped}\\)|Workflow\\([^)]*${escaped}[^)]*\\))`).test(text)
}

function hasWorkflowLaunchEvidence(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:Workflow launched in background|Running in background|Run ID:\\s*wf_|Task ID:\\s*w[a-z0-9-]+|\\b\\d+ background workflow\\b|[●✔◯]\\s+(?:workflow )?${escaped}\\s+\\d+\\/\\d+ agents .*\\b(?:running|done)\\b|◯ ${escaped}\\s+.*\\d+\\/\\d+ agents done)`).test(text)
}

function hasWorkflowPanel(text) {
  return /Dynamic workflows/.test(text) && /(?:No dynamic workflows in this session|Enter to view|↑\/↓ to select|Esc to close)/.test(text)
}

function hasKnownNonWorkflowResponse(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:Unknown command|Unknown skill|No command found|Usage: /${escaped}|not available|未找到|未知命令)`, 'i').test(text)
}

async function delay(ms) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

async function writeFixture(cwd) {
  await writeFile(join(cwd, 'package.json'), '{"private":true,"scripts":{"test":"echo test placeholder"}}\n')
  await writeFile(join(cwd, 'README.md'), '# Workflow slash probe fixture\n\nThis isolated directory is used for tmux slash command parity probes.\n')
}

async function probeExecutor({ label, command, args, scenario }) {
  const session = `workflow-slash-${scenario.name}-${label}-${process.pid}`
  const executorRoot = join(outputRoot, scenario.name, label)
  const cwd = join(executorRoot, 'cwd')
  await rm(executorRoot, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  await writeFixture(cwd)

  const env = {
    ...process.env,
    CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS',
    CLAUDE_CODE_WORKFLOWS: '1',
    NO_COLOR: '1',
  }
  const envArgs = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  const fullCommand = [shellQuote(command), ...args.map(shellQuote)].join(' ')
  const captures = {}
  let finalText = ''

  async function capture(name) {
    const visibleAnsi = tmux(['capture-pane', '-e', '-p', '-t', session])
    const historyAnsi = tmux(['capture-pane', '-e', '-p', '-S', '-', '-t', session])
    const visibleText = normalize(visibleAnsi)
    const historyText = normalize(historyAnsi)
    await writeFile(join(executorRoot, `${name}.ansi`), visibleAnsi)
    await writeFile(join(executorRoot, `${name}.txt`), `${visibleText}\n`)
    await writeFile(join(executorRoot, `${name}.history.ansi`), historyAnsi)
    await writeFile(join(executorRoot, `${name}.history.txt`), `${historyText}\n`)
    captures[name] = join(executorRoot, `${name}.history.txt`)
    return historyText
  }

  function send(keys) {
    tmux(['send-keys', '-t', session, ...keys])
  }

  function typeLiteral(value) {
    tmux(['send-keys', '-t', session, '-l', value])
  }

  async function acceptPrompts(prefix, attempts = 8) {
    let latest = ''
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await capture(`${prefix}-${attempt}`)
      if (!hasPermissionPrompt(latest)) return latest
      send(['Enter'])
      await delay(1500)
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
      ...envArgs,
      'sh',
      '-lc',
      fullCommand,
    ])
    await delay(2500)
    for (const key of ['Enter', 'Enter', 'Escape']) {
      send([key])
      await delay(500)
    }
    await capture('startup')

    send(['C-u'])
    await delay(300)
    typeLiteral(scenario.prompt)
    await delay(500)
    send(['Enter'])

    const deadline = Date.now() + waitMs
    let index = 0
    while (Date.now() < deadline) {
      await delay(3000)
      finalText = await acceptPrompts(`after-command-${index}`, 3)
      if (/Cannot read properties of undefined \(reading 'execution'\)/.test(finalText)) break
      if (hasWorkflowToolCall(finalText, scenario.expectedOfficialWorkflowName) || hasWorkflowLaunchEvidence(finalText, scenario.expectedOfficialWorkflowName)) break
      if (hasWorkflowPanel(finalText) || hasKnownNonWorkflowResponse(finalText, scenario.name)) break
      if (/Request timed out|API Error|Error:/.test(finalText)) break
      index += 1
    }

    finalText = [finalText, await capture('final')].join('\n')
    const report = {
      label,
      command: [command, ...args].join(' '),
      cwd,
      scenario: scenario.name,
      prompt: scenario.prompt,
      session,
      hasExecutionCrash: /Cannot read properties of undefined \(reading 'execution'\)/.test(finalText),
      hasWorkflowToolCall: hasWorkflowToolCall(finalText, scenario.expectedOfficialWorkflowName),
      hasWorkflowLaunchEvidence: hasWorkflowLaunchEvidence(finalText, scenario.expectedOfficialWorkflowName),
      hasWorkflowPanel: hasWorkflowPanel(finalText),
      hasKnownNonWorkflowResponse: hasKnownNonWorkflowResponse(finalText, scenario.name),
      hasTimeoutOrApiError: /Request timed out|API Error/.test(finalText),
      outputDir: executorRoot,
      captures,
    }
    report.classification = report.hasExecutionCrash
      ? 'execution-crash'
      : report.hasWorkflowToolCall || report.hasWorkflowLaunchEvidence
        ? 'workflow'
        : report.hasWorkflowPanel
          ? 'workflow-panel'
          : report.hasKnownNonWorkflowResponse
            ? 'non-workflow-response'
            : report.hasTimeoutOrApiError
              ? 'timeout-or-api-error'
              : 'unknown'
    await writeFile(join(executorRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  }
}

await mkdir(outputRoot, { recursive: true })
const reports = []
for (const scenario of scenarios) {
  const official = await probeExecutor({ label: 'official', command: officialBinary, args: ['--dangerously-skip-permissions', '--settings', disableDetectiveSettings], scenario })
  const local = await probeExecutor({ label: 'local', command: localBinary, args: localArgs, scenario })
  const parity = {
    officialObserved: official.classification !== 'unknown',
    localMatchesExpectedStrategy: local.classification === scenario.expectedLocalClassification,
    localMatchesOfficialClassification: local.classification === official.classification,
    neitherExecutionCrash: !official.hasExecutionCrash && !local.hasExecutionCrash,
    neitherTimedOutOrApiErrored: !official.hasTimeoutOrApiError && !local.hasTimeoutOrApiError,
    localDoesNotMissOfficialWorkflow: official.classification !== 'workflow' || local.classification === 'workflow',
  }
  const passed = Object.values(parity).every(Boolean)
  reports.push({ scenario: scenario.name, prompt: scenario.prompt, official, local, parity, passed })
}
const report = {
  generatedAt: new Date().toISOString(),
  officialBinary,
  localCommand: [localBinary, ...localArgs].join(' '),
  reports,
  summary: {
    passed: reports.filter(result => result.passed).length,
    total: reports.length,
    failed: reports.filter(result => !result.passed).map(result => result.scenario),
  },
}
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`workflow slash commands probe output: ${outputRoot}`)
for (const result of reports) {
  console.log(`${result.scenario}: passed=${result.passed} official=${result.official.classification} local=${result.local.classification}`)
}
if (reports.some(result => !result.passed)) process.exitCode = 1
