import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { listTasks, renderPrompt, selectTasks, TASK_TYPES } from './tasks'

test('every task loads, has a prompt and graders, and lab tasks name their lab', () => {
  const tasks = listTasks()
  expect(tasks.length).toBeGreaterThanOrEqual(15)
  for (const t of tasks) {
    expect(TASK_TYPES).toContain(t.type)
    expect(t.prompt.length).toBeGreaterThan(20)
    for (const g of t.grade) if (g.type === 'regex') expect(() => new RegExp(g.pattern, g.flags)).not.toThrow()
    if (t.type === 'troubleshoot') {
      expect(t.lab).toBeDefined()
      expect(fs.existsSync(path.join(t.dir, '..', '..', 'labs', t.lab!.kind, `${t.lab!.kind}_up.sh`))).toBe(true)
    }
  }
})

test('every task type has a short and a long task', () => {
  const tasks = listTasks()
  for (const type of TASK_TYPES) {
    const lens = new Set(tasks.filter(t => t.type === type).map(t => t.length))
    expect([...lens].sort()).toEqual(['long', 'short'])
  }
})

test('selection by id or type, and lab placeholders', () => {
  expect(selectTasks('ops').map(t => t.id)).toEqual(['ops'])
  expect(selectTasks('type:ops').map(t => t.id)).toEqual(['ops', 'ops-s'])
  expect(() => selectTasks('nope')).toThrow()
  const [ssh] = selectTasks('ssh-s')
  const p = renderPrompt(ssh, { PORT: '2601' })
  expect(p).toContain('-p 2601')
  expect(p).not.toContain('{PORT}')
})
