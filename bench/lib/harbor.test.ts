import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectCommands, containerName, harborTask, PUBLIC_DIR, readPicks, separateVerifier, tomlValue } from './harbor'

test('task.toml values by section', () => {
  const toml = 'version = "1.0"\n[environment]\ndocker_image = "alexgshaw/regex-log:20251031"\n[agent]\ntimeout_sec = 900.0\n[verifier]\ntimeout_sec = 600\n'
  expect(tomlValue(toml, 'environment', 'docker_image')).toBe('alexgshaw/regex-log:20251031')
  expect(tomlValue(toml, 'agent', 'timeout_sec')).toBe('900.0')
  expect(tomlValue(toml, null, 'docker_image')).toBeUndefined()
})

test('plan A picks each have a perturbed variant with an oracle and a change log', () => {
  const picks = readPicks(path.join(PUBLIC_DIR, 'picks-A.txt'))
  expect(picks).toHaveLength(20)
  expect(new Set(picks.map(p => p.suite))).toEqual(new Set(['tb2', 'swebenchpro', 'spreadsheetbench-verified']))
  for (const { suite, task } of picks) {
    const d = path.join(PUBLIC_DIR, 'perturb', 'seed1108', suite, task)
    for (const f of ['instruction.md', 'PERTURB.md', 'tests', 'solution']) expect(fs.existsSync(path.join(d, f))).toBe(true)
  }
})

test('container names stay unique and valid for long SWE-bench Pro task ids', () => {
  const t = { suite: 'swebenchpro', task: 'instance_internetarchive__openlibrary-89e4b4431fe7506c365a6f6eb6f6d048d04c044c-v08d8e8889ec945ab821fb156c04c7d2e2810debb', dir: '' }
  const names = new Set<string>()
  for (const cell of ['fork-claude-key', 'fork-claude-key-sub', 'codex'])
    for (const variant of ['', 'seed1108'])
      for (const rep of [1, 2, 3]) {
        const n = containerName(t, cell, variant, rep)
        expect(n).toMatch(/^[a-z0-9][a-z0-9_.-]+$/)
        expect(n.length).toBeLessThan(120)
        names.add(n)
      }
  expect(names.size).toBe(18)
})

test('separate-verifier tasks: environment mode and collect hooks', () => {
  const toml =
    '[verifier]\nnetwork_mode = "no-network"\nenvironment_mode = "separate"\n\n[[verifier.collect]]\ncommand = "cd /app && git diff --binary abc HEAD > /logs/artifacts/model.patch"\ntimeout_sec = 300.0\n\n[agent]\ntimeout_sec = 5400.0\n'
  expect(separateVerifier(toml)).toBe(true)
  expect(collectCommands(toml)).toEqual(['cd /app && git diff --binary abc HEAD > /logs/artifacts/model.patch'])
  expect(separateVerifier('[verifier]\ntimeout_sec = 900.0\n')).toBe(false)
  expect(collectCommands('[verifier]\ntimeout_sec = 900.0\n')).toEqual([])
})

test('FrontierHarness v1 picks: 21 Terminal-Bench 2 + 9 DeepSWE tasks', () => {
  const picks = readPicks(path.join(PUBLIC_DIR, 'picks-frontierharness-v1.txt'))
  expect(picks.filter(p => p.suite === 'tb2')).toHaveLength(21)
  expect(picks.filter(p => p.suite === 'deepswe')).toHaveLength(9)
})

test('deepswe tasks resolve under BENCH_DEEPSWE_ROOT/tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepswe-'))
  fs.mkdirSync(path.join(root, 'tasks', 'anko'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tasks', 'anko', 'task.toml'), '')
  expect(harborTask('deepswe', 'anko', undefined, { BENCH_DEEPSWE_ROOT: root }).dir).toBe(path.join(root, 'tasks', 'anko'))
  expect(() => harborTask('deepswe', 'anko', undefined, {})).toThrow('set BENCH_DEEPSWE_ROOT')
  fs.rmSync(root, { recursive: true })
})
