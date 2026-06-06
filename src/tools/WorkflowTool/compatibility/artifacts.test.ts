import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createCaseWorkspace,
  writeExecutorArtifacts,
} from './artifacts.js'

describe('workflow compatibility artifacts', () => {
  it('creates isolated case workspaces and writes executor artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-compat-artifacts-'))
    try {
      const workspace = await createCaseWorkspace({
        outputRoot: root,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        fixtureFiles: {
          'README.md': '# fixture\n',
          '.claude/workflows/demo.js': 'export default workflow({ name: "Demo", phases: [] })\n',
        },
      })

      const artifacts = await writeExecutorArtifacts({
        workspacePath: workspace,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        command: ['/opt/homebrew/bin/claude', '-p', 'hello'],
        env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS' },
        stdout: 'out',
        stderr: 'err',
        metadata: { exitCode: 0 },
      })

      assert.equal(artifacts.caseId, 'ARGS-001')
      assert.equal(artifacts.executor, 'official')
      assert.ok(artifacts.stdoutPath.endsWith('stdout.txt'))
      assert.ok(artifacts.filesManifestPath.endsWith('files.json'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recreates workspace when command execution removed it before artifact writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-compat-artifacts-'))
    try {
      const workspace = join(root, 'ARGS-001', 'official', 'attempt-1')
      const artifacts = await writeExecutorArtifacts({
        workspacePath: workspace,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        command: ['claude'],
        env: {},
        stdout: 'out',
        stderr: '',
        metadata: {},
      })

      assert.equal(await readFile(artifacts.stdoutPath, 'utf8'), 'out')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears stale attempt workspace contents before copying fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-compat-artifacts-'))
    try {
      const firstWorkspace = await createCaseWorkspace({
        outputRoot: root,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        fixtureFiles: { 'stale.txt': 'old\n' },
      })
      await writeFile(join(firstWorkspace, 'generated.txt'), 'stale output\n')

      const secondWorkspace = await createCaseWorkspace({
        outputRoot: root,
        caseId: 'ARGS-001',
        executor: 'official',
        attempt: 1,
        fixtureFiles: { 'fresh.txt': 'new\n' },
      })

      assert.equal(secondWorkspace, firstWorkspace)
      await assert.rejects(readFile(join(secondWorkspace, 'generated.txt'), 'utf8'))
      assert.equal(await readFile(join(secondWorkspace, 'fresh.txt'), 'utf8'), 'new\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
