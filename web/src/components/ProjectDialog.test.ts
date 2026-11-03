import { describe, expect, it } from 'bun:test'
import type { ModelOption } from '../protocol'
import { taskDefaultMenu } from './ProjectDialog'

const OPENAI_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
// A ChatGPT sign-in's list: no `default` row, the coordinator's model past the first four.
const models: ModelOption[] = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'daybreak-blue', 'gpt-6-luna'].map(
  value => ({ value, displayName: value, effortLevels: OPENAI_LEVELS }),
)

describe('taskDefaultMenu', () => {
  it('inherit lists the coordinator model and offers its effort levels', () => {
    const menu = taskDefaultMenu(models, null, null, 'daybreak-blue', false)
    expect(menu.shown.map(c => c.value)).toEqual([null, 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'daybreak-blue'])
    expect(menu.hidden).toBe(1)
    expect(menu.efforts).toEqual([null, ...OPENAI_LEVELS])
  })

  it('a picked model decides the effort levels', () => {
    const claude: ModelOption[] = [
      { value: 'default', displayName: 'Default', effortLevels: ['low', 'medium', 'high'] },
      { value: 'opus', displayName: 'Opus', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ]
    expect(taskDefaultMenu(claude, 'opus', null, undefined, false).efforts).toEqual([null, 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(taskDefaultMenu(claude, null, null, undefined, false).efforts).toEqual([null, 'low', 'medium', 'high'])
  })
})
