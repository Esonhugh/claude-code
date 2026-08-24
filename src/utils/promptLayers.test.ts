import { describe, expect, test } from 'bun:test'
import { resolvePromptSections } from './promptLayers.js'

describe('resolvePromptSections', () => {
  test('orders layers and removes repeated ids or content', () => {
    const sections = resolvePromptSections([
      { id: 'task', layer: 'task-dynamic', content: 'task' },
      { id: 'capability', layer: 'capability', content: 'capability' },
      { id: 'core', layer: 'stable-core', content: 'core' },
      { id: 'task', layer: 'task-dynamic', content: 'task' },
      { id: 'duplicate-content', layer: 'task-dynamic', content: 'capability' },
      { id: 'empty', layer: 'capability', content: null },
    ])

    expect(sections).toEqual([
      { id: 'core', layer: 'stable-core', content: 'core' },
      { id: 'capability', layer: 'capability', content: 'capability' },
      { id: 'task', layer: 'task-dynamic', content: 'task' },
    ])
  })

  test('allows explicit task-dynamic overrides without moving static layers', () => {
    const sections = resolvePromptSections([
      { id: 'language', layer: 'stable-core', content: 'Respond in English.' },
      {
        id: 'language',
        layer: 'task-dynamic',
        content: 'Respond in Chinese.',
        relation: 'override-default',
      },
      { id: 'safety', layer: 'stable-core', content: 'Ask before push.' },
    ])

    expect(sections).toEqual([
      { id: 'safety', layer: 'stable-core', content: 'Ask before push.' },
      { id: 'language', layer: 'task-dynamic', content: 'Respond in Chinese.' },
    ])
  })

  test('rejects implicit conflicting content for the same section id', () => {
    expect(() =>
      resolvePromptSections([
        { id: 'shared', layer: 'task-dynamic', content: 'task override' },
        { id: 'shared', layer: 'capability', content: 'capability override' },
        { id: 'shared', layer: 'stable-core', content: 'stable rule' },
      ]),
    ).toThrow('Prompt section "shared" has conflicting content')
  })

  test('keeps explicit reinforcements even when content matches', () => {
    const sections = resolvePromptSections([
      { id: 'owner', layer: 'stable-core', content: 'Ask before push.' },
      {
        id: 'mode-reinforcement',
        layer: 'task-dynamic',
        content: 'Ask before push.',
        relation: 'reinforce',
      },
    ])

    expect(sections).toEqual([
      { id: 'owner', layer: 'stable-core', content: 'Ask before push.' },
      {
        id: 'mode-reinforcement',
        layer: 'task-dynamic',
        content: 'Ask before push.',
      },
    ])
  })

  test('checks id conflicts before deduplicating content', () => {
    expect(() =>
      resolvePromptSections([
        { id: 'first', layer: 'stable-core', content: 'duplicate' },
        { id: 'shared', layer: 'stable-core', content: 'duplicate' },
        { id: 'shared', layer: 'task-dynamic', content: 'conflict' },
      ]),
    ).toThrow('Prompt section "shared" has conflicting content')
  })
})
