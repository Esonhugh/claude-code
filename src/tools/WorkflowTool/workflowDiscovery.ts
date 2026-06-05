import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import { isENOENT } from '../../utils/errors.js'

import type { WorkflowDryRunPlan, WorkflowSpec } from './workflowSpec.js'
import { loadWorkflowScriptSpec } from './workflowDsl.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'

export type DiscoveredWorkflowSpec = {
  commandName: string
  path: string
  spec: WorkflowSpec
  plan: WorkflowDryRunPlan
}

export type InvalidWorkflowSpec = {
  path: string
  error: string
}

export type WorkflowDiscoveryResult = {
  valid: DiscoveredWorkflowSpec[]
  invalid: InvalidWorkflowSpec[]
}

const WORKFLOW_DIRS = [join('docs', 'workflows'), join('.claude', 'workflows')]

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

async function findWorkflowRoots(cwd: string): Promise<string[]> {
  const roots: string[] = []
  let current = resolve(cwd)
  const root = parse(current).root

  while (true) {
    if (
      (await pathExists(join(current, '.git'))) ||
      (await pathExists(join(current, 'package.json')))
    ) {
      roots.push(current)
    }

    if (current === root) break
    current = dirname(current)
  }

  return roots.length > 0 ? roots : [resolve(cwd)]
}

function sanitizeCommandName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function workflowNameToCommandName(name: string, filePath: string): string {
  const commandName = sanitizeCommandName(name)
  if (commandName) return commandName

  const fallback = sanitizeCommandName(basename(filePath, extname(filePath)))
  if (fallback) return fallback

  throw new Error(`Cannot derive workflow command name from ${name} or ${filePath}`)
}

async function listWorkflowFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(
      entry =>
        entry.isFile() &&
        (entry.name.endsWith('.json') || entry.name.endsWith('.js')),
    )
    .map(entry => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

async function loadWorkflowFile(filePath: string, args: string): Promise<WorkflowSpec> {
  if (filePath.endsWith('.js')) {
    return loadWorkflowScriptSpec(filePath, args)
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as WorkflowSpec
}

export async function discoverWorkflowSpecs(cwd: string, args = ''): Promise<WorkflowDiscoveryResult> {
  const valid: DiscoveredWorkflowSpec[] = []
  const invalid: InvalidWorkflowSpec[] = []
  const usedCommandNames = new Set<string>()

  const searchedDirs = new Set<string>()
  for (const root of await findWorkflowRoots(cwd)) {
    for (const relativeDir of WORKFLOW_DIRS) {
      const dir = resolve(root, relativeDir)
      if (searchedDirs.has(dir)) continue
      searchedDirs.add(dir)

      let files: string[]
      try {
        files = await listWorkflowFiles(dir)
      } catch (error) {
        if (isENOENT(error)) continue
        invalid.push({
          path: dir,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      for (const filePath of files) {
        try {
          const spec = await loadWorkflowFile(filePath, args)
          const plan = validateWorkflowSpec(spec)
          const commandName = workflowNameToCommandName(plan.name, filePath)

          if (usedCommandNames.has(commandName)) {
            invalid.push({
              path: filePath,
              error: `Duplicate workflow command name: ${commandName}`,
            })
            continue
          }

          usedCommandNames.add(commandName)
          valid.push({ commandName, path: filePath, spec, plan })
        } catch (error) {
          invalid.push({
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  return { valid, invalid }
}

export async function loadWorkflowSpecByNameOrPath(
  cwd: string,
  selector: string,
  args = '',
): Promise<DiscoveredWorkflowSpec> {
  const discovery = await discoverWorkflowSpecs(cwd, args)
  const trimmed = selector.trim()
  const absoluteSelector = resolve(cwd, trimmed)
  const matches = discovery.valid.filter(
    workflow =>
      workflow.commandName === trimmed ||
      workflow.plan.name === trimmed ||
      workflow.path === absoluteSelector ||
      workflow.path === trimmed,
  )

  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(`Multiple workflow specs match ${selector}; use a path or command name`)
  }

  const available = discovery.valid.map(workflow => workflow.commandName).join(', ')
  throw new Error(
    available
      ? `Workflow not found: ${selector}. Available workflows: ${available}`
      : 'No workflow specs found in docs/workflows or .claude/workflows',
  )
}
