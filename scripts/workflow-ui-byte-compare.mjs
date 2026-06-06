#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import stripAnsi from 'strip-ansi'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const localBinary = process.env.LOCAL_CLAUDE_BINARY ?? process.execPath
const localArgs = process.env.LOCAL_CLAUDE_BINARY
  ? []
  : [resolve(projectRoot, 'dist', 'cli.js')]
const outputRoot = resolve(projectRoot, '.claude', 'workflow-ui-byte-compare')
const width = process.env.WORKFLOW_UI_COLUMNS ?? '100'
const height = process.env.WORKFLOW_UI_ROWS ?? '30'
const waitSeconds = Number(process.env.WORKFLOW_UI_WAIT_SECONDS ?? '2')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function tmux(args) {
  return run('tmux', args).trimEnd()
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

function workflowPanelText(value) {
  const lines = normalizeText(value).split('\n')
  const titleIndex = lines.findIndex(line => line.includes('Dynamic workflows'))
  if (titleIndex === -1) return normalizeText(value)
  const panel = []
  for (const line of lines.slice(titleIndex)) {
    if (panel.length > 0 && /^\s*[❯>]\s*$/.test(line)) break
    if (panel.length > 0 && line.startsWith('─')) break
    panel.push(line.replace(/^\s*⎿\s*/, '').replace(/^\s{2,}/, ''))
  }
  return panel.join('\n').replace(/\n+$/g, '')
}

function firstDifference(left, right) {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return left.length === right.length ? -1 : length
}

async function captureCli({ label, command, args, isolateConfig = true }) {
  const session = `workflow-ui-${label}-${process.pid}`
  const cwd = join(outputRoot, `${label}-cwd`)
  await mkdir(cwd, { recursive: true })
  const env = {
    ...process.env,
    ...(isolateConfig
      ? {
          HOME: join(outputRoot, `${label}-home`),
          CLAUDE_CONFIG_DIR: join(outputRoot, `${label}-config`),
        }
      : {}),
    CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS',
    CLAUDE_CODE_WORKFLOWS: '1',
    NO_COLOR: '1',
  }
  if (isolateConfig) {
    await mkdir(env.HOME, { recursive: true })
    await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
  }
  const fullCommand = [shellQuote(command), ...args.map(shellQuote)].join(' ')
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
      fullCommand,
    ])
    await new Promise(resolveWait => setTimeout(resolveWait, 1200))
    for (const key of ['Enter', 'Enter', 'Enter', 'Enter']) {
      tmux(['send-keys', '-t', session, key])
      await new Promise(resolveWait => setTimeout(resolveWait, 300))
    }
    tmux(['send-keys', '-t', session, '/workflows', 'Enter'])
    await new Promise(resolveWait => setTimeout(resolveWait, waitSeconds * 1000))
    const ansi = tmux(['capture-pane', '-e', '-p', '-S', '-', '-t', session])
    const text = normalizeText(ansi)
    const panelText = workflowPanelText(ansi)
    await writeFile(join(outputRoot, `${label}.ansi`), ansi)
    await writeFile(join(outputRoot, `${label}.txt`), `${text}\n`)
    await writeFile(join(outputRoot, `${label}.workflow-panel.txt`), `${panelText}\n`)
    if (!text.trim()) {
      throw new Error(`${label} workflow UI capture was empty`)
    }
    if (!panelText.includes('Dynamic workflows')) {
      throw new Error(`${label} workflow UI capture did not reach /workflows panel`)
    }
    return { ansi, text, panelText }
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' })
  }
}

if (!existsSync(officialBinary)) {
  throw new Error(`Official Claude binary not found: ${officialBinary}`)
}
if (!existsSync(resolve(projectRoot, 'dist', 'cli.js')) && !process.env.LOCAL_CLAUDE_BINARY) {
  throw new Error('Local dist/cli.js not found; run npm run build first')
}

await mkdir(outputRoot, { recursive: true })
const official = await captureCli({ label: 'official', command: officialBinary, args: [] })
const local = await captureCli({ label: 'local', command: localBinary, args: localArgs, isolateConfig: false })

const textDiffIndex = firstDifference(official.text, local.text)
const ansiDiffIndex = firstDifference(official.ansi, local.ansi)
const workflowPanelDiffIndex = firstDifference(official.panelText, local.panelText)
const report = {
  generatedAt: new Date().toISOString(),
  officialBinary,
  localCommand: [localBinary, ...localArgs].join(' '),
  terminal: { width: Number(width), height: Number(height) },
  ansiByteEqual: official.ansi === local.ansi,
  textByteEqual: official.text === local.text,
  workflowPanelByteEqual: official.panelText === local.panelText,
  ansiDiffIndex,
  textDiffIndex,
  workflowPanelDiffIndex,
  officialTextLength: official.text.length,
  localTextLength: local.text.length,
  artifacts: {
    officialAnsi: join(outputRoot, 'official.ansi'),
    officialText: join(outputRoot, 'official.txt'),
    localAnsi: join(outputRoot, 'local.ansi'),
    localText: join(outputRoot, 'local.txt'),
    officialWorkflowPanel: join(outputRoot, 'official.workflow-panel.txt'),
    localWorkflowPanel: join(outputRoot, 'local.workflow-panel.txt'),
  },
}
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`workflow UI byte compare output: ${outputRoot}`)
console.log(`ansiByteEqual=${report.ansiByteEqual}`)
console.log(`textByteEqual=${report.textByteEqual}`)
console.log(`workflowPanelByteEqual=${report.workflowPanelByteEqual}`)
if (!report.textByteEqual) {
  console.log(`textDiffIndex=${report.textDiffIndex}`)
}
if (!report.workflowPanelByteEqual) {
  console.log(`workflowPanelDiffIndex=${report.workflowPanelDiffIndex}`)
}
