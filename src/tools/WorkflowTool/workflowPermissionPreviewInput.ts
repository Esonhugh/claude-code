import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, parse, resolve } from 'node:path'
import type { WorkflowArgs, WorkflowDryRunPlan } from './workflowSpec.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { parseWorkflowScript } from './workflowScriptParser.js'
import { resolveWorkflowScriptPath } from './workflowScriptPersistence.js'

type WorkflowPermissionPreviewInputValue = {
  name?: string
  selector?: string
  script?: string
  scriptPath?: string
  args?: unknown
  runArgs?: unknown
  plan?: unknown
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function asWorkflowArgs(value: unknown): WorkflowArgs | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    typeof value === 'object'
  ) {
    return value as WorkflowArgs | undefined
  }
  return undefined
}

function planFromDryRunPlan(plan: WorkflowDryRunPlan): NonNullable<WorkflowPermissionPreviewInputValue['plan']> {
  return {
    name: plan.name,
    description: plan.description,
    phases: plan.phases.map(phase => ({
      title: titleCase(phase.id),
      detail: phase.description,
      prompt: phase.prompt,
    })),
  }
}

type PhaseAgents = { prompts: string[]; agents: number }

// Leading string or template literal of an agent() prompt argument, with ${...} shown as ${…};
// a prompt built from a variable has no static text and only counts toward "+N more".
function leadingLiteral(source: string): string | undefined {
  const quote = source[0]
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined
  let text = ''
  for (let i = 1; i < source.length; i++) {
    const char = source[i]!
    if (char === '\\') {
      text += source[++i] ?? ''
    } else if (char === quote) {
      return text.trim()
    } else if (quote === '`' && char === '$' && source[i + 1] === '{') {
      const close = source.indexOf('}', i)
      if (close === -1) return undefined
      text += '${…}'
      i = close
    } else {
      text += char
    }
  }
  return undefined
}

// Walks phase('Title') and agent(...) calls in source order so each agent prompt is listed
// under the phase that was active when it was spawned.
function agentsByPhase(scriptBody: string, titles: string[]): PhaseAgents[] {
  const byPhase = titles.map((): PhaseAgents => ({ prompts: [], agents: 0 }))
  let current = 0
  for (const match of scriptBody.matchAll(/\bphase\s*\(\s*(['"`])(.*?)\1|\bagent\s*\(\s*/g)) {
    if (match[2] !== undefined) {
      const index = titles.indexOf(match[2])
      if (index !== -1) current = index
      continue
    }
    const phase = byPhase[current]
    if (!phase || match.index === undefined) continue
    const argStart = match.index + match[0].length
    let prompt: string | undefined
    if (scriptBody[argStart] === '{') {
      // Object-form agent({ ... }): show the first lines of the options object.
      const previewLines: string[] = []
      for (const line of scriptBody.slice(argStart).split('\n')) {
        if (previewLines.length > 0 && /^\s*prompt\s*:/.test(line)) break
        previewLines.push(line.trimEnd())
        if (previewLines.length >= 3) break
      }
      prompt = previewLines.join('\n').trim()
    } else {
      prompt = leadingLiteral(scriptBody.slice(argStart))
    }
    phase.agents++
    if (prompt) phase.prompts.push(prompt)
  }
  return byPhase
}

function planFromScript(script: string): NonNullable<WorkflowPermissionPreviewInputValue['plan']> {
  const parsed = parseWorkflowScript(script)
  const phases = parsed.meta.phases ?? []
  const agents = agentsByPhase(parsed.scriptBody, phases.map(phase => phase.title))
  return {
    name: parsed.meta.name,
    description: parsed.meta.description,
    phases: phases.map((phase, index) => ({
      title: phase.title,
      ...(phase.detail ? { detail: phase.detail } : {}),
      ...(agents[index]?.prompts.length ? { prompts: agents[index].prompts } : {}),
      ...(agents[index]?.agents ? { agents: agents[index].agents } : {}),
    })),
    runScriptSnapshot: script,
  }
}

function sanitizeCommandName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function workflowRoots(cwd: string): Promise<string[]> {
  const roots: string[] = []
  let current = resolve(cwd)
  const root = parse(current).root
  while (true) {
    if ((await pathExists(join(current, '.git'))) || (await pathExists(join(current, 'package.json')))) {
      roots.push(current)
    }
    if (current === root) break
    current = resolve(current, '..')
  }
  return roots.length > 0 ? roots : [resolve(cwd)]
}

async function workflowSearchDirs(cwd: string): Promise<string[]> {
  const dirs = [join(homedir(), '.claude', 'workflows')]
  for (const root of await workflowRoots(cwd)) {
    dirs.push(join(root, 'docs', 'workflows'), join(root, '.claude', 'workflows'))
  }
  return [...new Set(dirs)]
}

async function readWorkflowScriptBySelector(
  cwd: string,
  selector: string,
): Promise<{ path: string; script: string } | undefined> {
  for (const dir of await workflowSearchDirs(cwd)) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const filePath = join(dir, entry.name)
      let script
      try {
        script = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      try {
        const parsed = parseWorkflowScript(script)
        const commandName = sanitizeCommandName(parsed.meta.name) || sanitizeCommandName(basename(filePath, extname(filePath)))
        if (selector === parsed.meta.name || selector === commandName || selector === filePath || selector === resolve(cwd, selector)) {
          return { path: filePath, script }
        }
      } catch {
        continue
      }
    }
  }
  return undefined
}

export async function workflowPermissionPreviewInput<T extends WorkflowPermissionPreviewInputValue>(
  input: T,
  cwd: string,
): Promise<T> {
  let script = input.script
  let resolvedScriptPath: string | undefined
  let discoveredPlan: WorkflowDryRunPlan | undefined

  if (!script && input.scriptPath) {
    try {
      resolvedScriptPath = await resolveWorkflowScriptPath({
        cwd,
        scriptPath: input.scriptPath,
      })
      script = await readFile(resolvedScriptPath, 'utf8')
    } catch {
      return input
    }
  }

  const selector = input.name ?? input.selector
  if (!script && selector) {
    try {
      const workflow = await loadWorkflowSpecByNameOrPath(
        cwd,
        selector,
        asWorkflowArgs(input.args ?? input.runArgs),
      )
      discoveredPlan = workflow.plan
      if (!workflow.path.startsWith('bundled:') && workflow.path.endsWith('.js')) {
        resolvedScriptPath = workflow.path
        script = await readFile(workflow.path, 'utf8')
      }
    } catch {
      const scriptMatch = await readWorkflowScriptBySelector(cwd, selector)
      if (!scriptMatch) return input
      resolvedScriptPath = scriptMatch.path
      script = scriptMatch.script
    }
  }

  if (script) {
    try {
      return {
        ...input,
        script,
        ...(resolvedScriptPath ? { scriptPath: resolvedScriptPath } : {}),
        plan: planFromScript(script),
      }
    } catch {
      return { ...input, script }
    }
  }

  if (discoveredPlan) {
    return {
      ...input,
      plan: planFromDryRunPlan(discoveredPlan),
    }
  }

  return input
}
