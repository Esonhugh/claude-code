/**
 * `claude purge [path]` — deletes a project's local Claude Code data, like
 * official 2.1.311. The fork also removes the project's rows from the SQLite
 * memory index.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { existsSync, realpathSync } from 'fs'
import { readdir, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { createInterface } from 'readline/promises'
import React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Box, Text } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import {
  countProjectIndexRows,
  defaultIndexPath,
  deleteProjectIndexRows,
} from '../../memdir/memoryIndex.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { lock } from '../../utils/lockfile.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'
import { findProjectDir } from '../../utils/sessionStoragePortable.js'
import { getTasksDir } from '../../utils/tasks.js'

type Item = {
  kind: 'dir' | 'file' | 'config-key' | 'history-lines' | 'index'
  path: string
  reason: string
}

type PurgeOptions = {
  all?: boolean
  dryRun?: boolean
  yes?: boolean
  interactive?: boolean
}

const PROJECT_ENTRY = 'project entry in ~/.claude.json (trust, history, MCP servers)'

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function exitWith(message: string, code: number): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function normalize(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

function isUnder(path: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) if (path === root || path.startsWith(root + sep)) return true
  return false
}

async function historyLines(paths: ReadonlySet<string>): Promise<{ kept: string[]; matched: number } | undefined> {
  let text: string
  try {
    text = await readFile(join(getClaudeConfigHomeDir(), 'history.jsonl'), 'utf8')
  } catch {
    return undefined
  }
  const kept: string[] = []
  let matched = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let project: unknown
    try {
      project = (JSON.parse(line) as { project?: unknown }).project
    } catch {
      project = undefined
    }
    if (typeof project === 'string' && isUnder(project, paths)) matched++
    else kept.push(line)
  }
  return { kept, matched }
}

function warnings(scope: 'project' | 'all'): string[] {
  const config = getClaudeConfigHomeDir()
  const result: string[] = []
  if (existsSync(join(config, 'shell-snapshots'))) {
    result.push('shell-snapshots/ are not project-scoped and will not be touched')
  }
  const backups = join(config, 'backups')
  if (existsSync(backups)) {
    result.push(
      scope === 'all'
        ? `backups/ may still contain project entries in old .claude.json snapshots (${backups}); at most 5 are kept and they rotate out automatically`
        : `backups/ may still contain this project entry in old .claude.json snapshots (${backups}); at most 5 are kept and they rotate out automatically`,
    )
  }
  return result
}

async function projectItems(paths: ReadonlySet<string>): Promise<Item[]> {
  const config = getClaudeConfigHomeDir()
  const projectDirs = new Set<string>()
  for (const p of paths) {
    const dir = await findProjectDir(p)
    if (dir) projectDirs.add(dir)
  }
  const items: Item[] = []
  for (const dir of projectDirs) {
    const sessions = (await readdir(dir).catch(() => [] as string[]))
      .filter(name => name.endsWith('.jsonl'))
      .map(name => name.slice(0, -'.jsonl'.length))
      .sort()
    for (const id of sessions) {
      const tasks = getTasksDir(id)
      if (existsSync(tasks)) items.push({ kind: 'dir', path: tasks, reason: `tasks for session ${id}` })
      const debug = join(config, 'debug', `${id}.txt`)
      if (existsSync(debug)) items.push({ kind: 'file', path: debug, reason: `debug log for session ${id}` })
      const history = join(config, 'file-history', id)
      if (existsSync(history)) items.push({ kind: 'dir', path: history, reason: `file edit history for session ${id}` })
    }
  }
  for (const dir of projectDirs) {
    items.push({ kind: 'dir', path: dir, reason: 'project transcripts (.jsonl) and memory/' })
  }
  for (const dir of projectDirs) {
    const rows = countProjectIndexRows(dir)
    if (rows > 0) items.push({ kind: 'index', path: dir, reason: `${rows} memory search index row(s) for this project` })
  }
  for (const key of Object.keys(getGlobalConfig().projects ?? {})) {
    if (paths.has(normalize(key))) items.push({ kind: 'config-key', path: key, reason: PROJECT_ENTRY })
  }
  const history = await historyLines(paths)
  if (history && history.matched > 0) {
    items.push({
      kind: 'history-lines',
      path: join(config, 'history.jsonl'),
      reason: `${history.matched} prompt(s) typed in this project`,
    })
  }
  return items
}

function allItems(): Item[] {
  const config = getClaudeConfigHomeDir()
  const items: Item[] = []
  for (const [name, reason] of [
    ['projects', 'all project transcripts (.jsonl) and memory/'],
    ['tasks', 'all session task lists'],
    ['debug', 'all session debug logs'],
    ['file-history', 'all session file edit history'],
  ] as const) {
    const path = join(config, name)
    if (existsSync(path)) items.push({ kind: 'dir', path, reason })
  }
  const history = join(config, 'history.jsonl')
  if (existsSync(history)) items.push({ kind: 'file', path: history, reason: 'prompt history across all projects' })
  const index = defaultIndexPath()
  if (existsSync(index)) items.push({ kind: 'file', path: index, reason: 'memory search index for all projects' })
  for (const key of Object.keys(getGlobalConfig().projects ?? {})) {
    items.push({ kind: 'config-key', path: key, reason: PROJECT_ENTRY })
  }
  return items
}

function describe(item: Item): string {
  const head =
    item.kind === 'config-key'
      ? `config: projects["${item.path}"]`
      : item.kind === 'history-lines'
        ? `filter: ${item.path}`
        : `${item.kind}:    ${item.path}`
  return `${head}\n           ${item.reason}`
}

function printPlan(target: string, items: Item[], notes: string[]): void {
  out(`\nPurge plan for ${target}:\n`)
  for (const item of items) out(`  ${describe(item)}`)
  if (notes.length > 0) {
    out()
    for (const note of notes) process.stderr.write(`${note}\n`)
  }
  out('\nPurging deletes data only on this computer, not anything stored by Anthropic.')
}

async function remove(item: Item, matchPaths: ReadonlySet<string>): Promise<string | null> {
  try {
    switch (item.kind) {
      case 'dir':
        await rm(item.path, { recursive: true, force: true })
        return null
      case 'file':
        await rm(item.path, { force: true })
        if (item.path === defaultIndexPath()) {
          await rm(`${item.path}-wal`, { force: true })
          await rm(`${item.path}-shm`, { force: true })
        }
        return null
      case 'index':
        deleteProjectIndexRows(item.path)
        return null
      case 'config-key':
        saveGlobalConfig(config => {
          if (!config.projects || !(item.path in config.projects)) return config
          const projects = { ...config.projects }
          delete projects[item.path]
          return { ...config, projects }
        })
        return null
      case 'history-lines': {
        const release = await lock(item.path, { stale: 10000, retries: { retries: 3, minTimeout: 50 } })
        try {
          const history = await historyLines(matchPaths)
          if (history) {
            await writeFile(item.path, history.kept.map(line => `${line}\n`).join(''), { mode: 0o600 })
          }
        } finally {
          await release()
        }
        return null
      }
    }
  } catch (error) {
    return `Could not delete ${item.path} — ${errorMessage(error)}`
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } catch {
    return false
  } finally {
    rl.close()
  }
}

async function choose<T extends string>(
  title: string,
  options: { label: string; value: T; description?: string }[],
  defaultValue?: T,
): Promise<T | null> {
  if (!process.stdin.isTTY) return null
  const { createRoot } = await import('../../ink.js')
  const root = await createRoot(getBaseRenderOptions(false))
  const picked = await new Promise<T | null>(done => {
    root.render(
      <KeybindingSetup>
        <Box flexDirection="column" gap={1} paddingY={1}>
          <Text bold>{title}</Text>
          <Select
            options={options}
            defaultValue={defaultValue}
            visibleOptionCount={10}
            onChange={value => done(value)}
            onCancel={() => done(null)}
          />
        </Box>
      </KeybindingSetup>,
    )
  })
  root.unmount()
  return picked
}

async function pickProject(): Promise<string | null> {
  const current = resolve(process.cwd())
  const seen = new Set([current])
  const options = [{ label: current, value: current, description: 'current directory' }]
  for (const key of Object.keys(getGlobalConfig().projects ?? {})) {
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ label: key, value: key, description: '' })
  }
  return choose('Select a project to purge:', options, current)
}

function finish(failures: string[], success: string): never {
  if (failures.length > 0) {
    exitWith(
      `${failures.length} item(s) failed:\n  ${failures.join('\n  ')}\nWhat could not be deleted is still on disk: fix the cause and run the command again, or delete those paths by hand.`,
      1,
    )
  }
  out(success)
  process.exit(0)
}

export async function purgeProjectHandler(path: string | undefined, options: PurgeOptions): Promise<never> {
  const config = getClaudeConfigHomeDir()
  if (options.all) {
    if (path) exitWith('Cannot specify both a path and --all.', 1)
    if (options.interactive) exitWith('Cannot use -i/--interactive with --all.', 1)
    const items = allItems()
    if (items.length === 0) exitWith(`No Claude Code project state found under ${config}.`, 1)
    printPlan('all projects', items, warnings('all'))
    if (options.dryRun) finish([], `Dry run: ${items.length} item(s) would be deleted.`)
    if (!options.yes && !(await confirm(`Delete ${items.length} item(s) for ALL projects from this computer? This can't be undone.`))) {
      exitWith('Aborted.', 1)
    }
    const failures: string[] = []
    for (const item of items) {
      const failure = await remove(item, new Set())
      if (failure) failures.push(failure)
    }
    finish(failures, `Purged ${items.length} item(s) across all projects.`)
  }

  const target = path ? resolve(path) : await pickProject()
  if (target === null) exitWith('Aborted.', 1)
  const matchPaths = new Set([normalize(target)])
  try {
    matchPaths.add(normalize(realpathSync(target)))
  } catch {
    // A deleted project still has data to purge.
  }
  const items = await projectItems(matchPaths)
  if (items.length === 0) exitWith(`No Claude Code project state found for ${target} under ${config}.`, 1)
  printPlan(target, items, warnings('project'))
  if (options.dryRun) finish([], `Dry run: ${items.length} item(s) would be deleted.`)

  const failures: string[] = []
  if (options.interactive) {
    let deleted = 0
    let deleteRest = false
    for (const [i, item] of items.entries()) {
      const action = deleteRest
        ? 'delete'
        : ((await choose(`[${i + 1}/${items.length}] ${describe(item)}`, [
            { label: 'Delete', value: 'delete' },
            { label: 'Skip', value: 'skip' },
            { label: 'Delete this and all remaining', value: 'all' },
            { label: 'Abort', value: 'abort' },
          ])) ?? 'abort')
      if (action === 'abort') exitWith(`Aborted. ${deleted} item(s) deleted.`, 1)
      if (action === 'skip') continue
      if (action === 'all') deleteRest = true
      const failure = await remove(item, matchPaths)
      if (failure) failures.push(failure)
      else deleted++
    }
    finish(failures, `Purged ${deleted}/${items.length} item(s) for ${target}.`)
  }

  if (!options.yes && !(await confirm(`Delete ${items.length} item(s) for ${target} from this computer? This can't be undone.`))) {
    exitWith('Aborted.', 1)
  }
  for (const item of items) {
    const failure = await remove(item, matchPaths)
    if (failure) failures.push(failure)
  }
  finish(failures, `Purged ${items.length} item(s) for ${target}.`)
}
