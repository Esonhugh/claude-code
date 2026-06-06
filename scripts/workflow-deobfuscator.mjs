#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultSymbols = [
  'WorkflowTool',
  'WorkflowDetailDialog',
  'WorkflowPermissionDialog',
  'workflowNeedsUsageConsentPrompt',
  'WorkflowBudgetExceededError',
  'workflow_progress',
  'workflow_agent',
  'workflow_phase',
  'workflow_log',
  'skipWorkflowAgent',
  'retryWorkflowAgent',
  'pauseWorkflowTask',
  'killWorkflowTask',
  'deep-research',
  'code-review',
  'bughunt',
  'bugfix',
  'investigate',
  'dashboard',
  'docs',
  'autopilot',
]

const workflowNamePattern = /\b(?:deep-research|code-review|bughunt-lite|bughunt|bugfix|investigate|dashboard|docs|autopilot|plan-hunter|review-branch)\b/g
const eventNamePattern = /\bworkflow_(?:progress|agent|phase|log)\b/g
const controlNamePattern = /\b(?:skipWorkflowAgent|retryWorkflowAgent|pauseWorkflowTask|killWorkflowTask)\b/g

export function normalizeSnippet(value) {
  return [...value]
    .map(char => {
      const code = char.charCodeAt(0)
      return code <= 0x1f || code === 0x7f ? ' ' : char
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function extractStrings(binaryPath) {
  return execFileSync('strings', [binaryPath], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
}

function findFunctionStart(source, index) {
  const functionIndex = source.lastIndexOf('function ', index)
  const assignmentIndex = Math.max(
    source.lastIndexOf('=>', index),
    source.lastIndexOf('=(', index),
    source.lastIndexOf('=function', index),
  )
  if (functionIndex === -1) return Math.max(0, assignmentIndex)
  if (assignmentIndex === -1) return functionIndex
  return Math.max(functionIndex, assignmentIndex)
}

export function extractBalancedSnippet(source, index) {
  const start = findFunctionStart(source, index)
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) return normalizeSnippet(source.slice(start, index + 240))

  let depth = 0
  let quote
  let escaped = false
  for (let cursor = braceStart; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, cursor + 1).trim()
    }
  }

  return source.slice(start, Math.min(source.length, braceStart + 1200)).trim()
}

function symbolNeighborhoods(source, symbols, contextBytes) {
  const neighborhoods = []
  for (const symbol of symbols) {
    let offset = source.indexOf(symbol)
    while (offset !== -1) {
      neighborhoods.push({
        symbol,
        offset,
        context: normalizeSnippet(source.slice(
          Math.max(0, offset - contextBytes),
          Math.min(source.length, offset + symbol.length + contextBytes),
        )),
      })
      offset = source.indexOf(symbol, offset + symbol.length)
    }
  }
  neighborhoods.sort((left, right) => left.offset - right.offset || left.symbol.localeCompare(right.symbol))
  const seen = new Set()
  return neighborhoods.filter(item => {
    const key = `${item.symbol}:${item.offset}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function scriptCandidates(source) {
  const candidates = []
  const needle = 'export const meta'
  let offset = source.indexOf(needle)
  while (offset !== -1) {
    const start = Math.max(0, offset - 160)
    const nextOffset = source.indexOf(needle, offset + needle.length)
    const fallbackEnd = Math.min(source.length, offset + 64_000)
    const end = nextOffset === -1 ? fallbackEnd : Math.min(nextOffset, fallbackEnd)
    candidates.push({
      offset,
      snippet: normalizeSnippet(source.slice(start, end)),
    })
    offset = nextOffset
  }
  return candidates
}

function balancedSnippetsForSymbols(source, symbols) {
  return symbols.flatMap(symbol => {
    const index = source.indexOf(symbol)
    if (index === -1) return []
    return [{ symbol, snippet: normalizeSnippet(extractBalancedSnippet(source, index)) }]
  })
}

export function extractWorkflowEvidence(source, options = {}) {
  const symbols = options.symbols ?? defaultSymbols
  const contextBytes = options.contextBytes ?? 320
  return {
    generatedAt: new Date().toISOString(),
    symbols: symbolNeighborhoods(source, symbols, contextBytes),
    workflowNames: uniqueSorted(source.match(workflowNamePattern) ?? []),
    eventNames: uniqueSorted(source.match(eventNamePattern) ?? []),
    controlNames: uniqueSorted(source.match(controlNamePattern) ?? []),
    scriptCandidates: scriptCandidates(source),
    balancedSnippets: balancedSnippetsForSymbols(source, symbols),
  }
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const projectRoot = resolve(scriptDir, '..')
  const binaryPath = process.argv[2] ?? '/opt/homebrew/bin/claude'
  const outputRoot = resolve(projectRoot, '.claude', 'workflow-deobfuscation')
  if (!existsSync(binaryPath)) throw new Error(`Binary not found: ${binaryPath}`)
  await mkdir(outputRoot, { recursive: true })
  const source = extractStrings(binaryPath)
  const evidence = extractWorkflowEvidence(source)
  evidence.binaryPath = binaryPath
  await writeFile(resolve(outputRoot, 'workflow-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await writeFile(
    resolve(outputRoot, 'workflow-script-candidates.txt'),
    evidence.scriptCandidates.map((candidate, index) => `# candidate ${index + 1} @ ${candidate.offset}\n${candidate.snippet}\n`).join('\n'),
  )
  await writeFile(
    resolve(outputRoot, 'workflow-symbol-neighborhoods.txt'),
    evidence.symbols.map(item => `# ${item.symbol} @ ${item.offset}\n${item.context}\n`).join('\n'),
  )
  console.log(`workflow deobfuscation output: ${outputRoot}`)
  console.log(`symbols: ${evidence.symbols.length}`)
  console.log(`workflow names: ${evidence.workflowNames.join(', ')}`)
  console.log(`script candidates: ${evidence.scriptCandidates.length}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
