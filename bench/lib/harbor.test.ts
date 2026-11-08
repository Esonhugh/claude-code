import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_DIR, readPicks, tomlValue } from './harbor'

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
