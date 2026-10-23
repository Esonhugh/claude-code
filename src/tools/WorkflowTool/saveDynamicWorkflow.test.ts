import assert from 'node:assert/strict'
import { afterAll, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultDynamicWorkflowName,
  saveDynamicWorkflow,
  WORKFLOW_SAVE_OVERWRITE_HINT,
  workflowSavePathPreview,
} from './saveDynamicWorkflow.js'
import { workflowSaveDir } from './workflowDiscovery.js'

const root = await mkdtemp(join(tmpdir(), 'save-dynamic-workflow-'))
const repo = join(root, 'repo')
const nested = join(repo, 'packages', 'app')
const home = join(root, 'home')
await mkdir(join(repo, '.git'), { recursive: true })
await mkdir(nested, { recursive: true })
await mkdir(home, { recursive: true })
const script = `export const meta = { name: 'Probe Flow', description: 'probe' }\nreturn 1\n`

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

test('project scope saves under the nearest project root with the official modes', async () => {
  const saved = await saveDynamicWorkflow({ name: 'Probe Flow', scope: 'project', script, overwrite: false, cwd: nested })
  assert.deepEqual(saved, { name: 'probe-flow', path: join(repo, '.claude', 'workflows', 'probe-flow.js'), scope: 'project' })
  assert.equal(await readFile(saved.path, 'utf8'), script)
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(repo, '.claude', 'workflows'))).mode & 0o777, 0o700)
})

test('an existing .claude/workflows at a nearer project root wins over the outer one', async () => {
  // Only directories discovery treats as roots (.git or package.json) are candidates.
  await mkdir(join(nested, '.claude', 'workflows'), { recursive: true })
  assert.equal(await workflowSaveDir('project', nested), join(repo, '.claude', 'workflows'))
  await writeFile(join(nested, 'package.json'), '{}')
  assert.equal(await workflowSaveDir('project', nested), join(nested, '.claude', 'workflows'))
  await rm(join(nested, '.claude'), { recursive: true })
  assert.equal(await workflowSaveDir('project', nested), join(repo, '.claude', 'workflows'))
  await rm(join(nested, 'package.json'))
  // Without any project root marker the cwd itself is the project.
  assert.equal(await workflowSaveDir('project', home), join(home, '.claude', 'workflows'))
})

test('user scope saves under ~/.claude/workflows', async () => {
  const saved = await saveDynamicWorkflow({ name: 'user flow', scope: 'user', script, overwrite: false, cwd: nested, home })
  assert.equal(saved.path, join(home, '.claude', 'workflows', 'user-flow.js'))
  assert.equal(await workflowSaveDir('user', nested, { home }), join(home, '.claude', 'workflows'))
})

test('a name collision refuses without overwrite and replaces with it', async () => {
  const path = join(repo, '.claude', 'workflows', 'probe-flow.js')
  await assert.rejects(
    saveDynamicWorkflow({ name: 'probe flow', scope: 'project', script: 'return 2', overwrite: false, cwd: repo }),
    { message: `Dynamic workflow "probe-flow" already exists at ${path}. ${WORKFLOW_SAVE_OVERWRITE_HINT}` },
  )
  assert.equal(await readFile(path, 'utf8'), script)
  await saveDynamicWorkflow({ name: 'probe flow', scope: 'project', script: 'return 2', overwrite: true, cwd: repo })
  assert.equal(await readFile(path, 'utf8'), 'return 2')
  // Other write errors surface unchanged.
  await writeFile(join(repo, '.claude', 'workflows', 'blocker'), '')
  await assert.rejects(
    saveDynamicWorkflow({ name: 'x', scope: 'project', script, overwrite: false, cwd: join(repo, '.claude', 'workflows', 'blocker') }),
    (error: NodeJS.ErrnoException) => error.code !== 'EEXIST' && !error.message.includes(WORKFLOW_SAVE_OVERWRITE_HINT),
  )
})

test('path preview and default name follow the official rules', () => {
  assert.equal(workflowSavePathPreview('Probe Flow', 'project'), '.claude/workflows/probe-flow.js')
  assert.equal(workflowSavePathPreview('Probe Flow', 'user'), '~/.claude/workflows/probe-flow.js')
  assert.equal(workflowSavePathPreview('   ', 'project'), '.claude/workflows/workflow.js')
  assert.equal(defaultDynamicWorkflowName({ runScriptSnapshot: script, summary: 'ignored', description: 'Workflow: x' }), 'Probe Flow')
  assert.equal(defaultDynamicWorkflowName({ runScriptSnapshot: 'return 1', summary: 'Review Changes', description: 'Workflow: x' }), 'review-changes')
  assert.equal(defaultDynamicWorkflowName({ runScriptSnapshot: 'export const meta = {', summary: undefined, description: 'Workflow: Big Run' }), 'workflow-big-run')
})
