import { describe, expect, test } from 'bun:test'
import { toolDiff } from './diff'

describe('toolDiff', () => {
  test('uses the structured patch of the result with its line numbers', () => {
    const diff = toolDiff('Edit', JSON.stringify({ file_path: '/w/a.py', old_string: 'x', new_string: 'y' }), {
      structuredPatch: [
        { oldStart: 41, oldLines: 2, newStart: 41, newLines: 3, lines: [' def main(args):', '-    m = mrr()', '+    k = 10', '+    m = recall(k)'] },
      ],
    })
    expect(diff).toEqual({
      added: 2,
      removed: 1,
      created: false,
      rows: [
        { kind: 'hunk', text: '@@ -41,2 +41,3 @@' },
        { kind: 'ctx', old: 41, new: 41, text: 'def main(args):' },
        { kind: 'del', old: 42, text: '    m = mrr()' },
        { kind: 'add', new: 42, text: '    k = 10' },
        { kind: 'add', new: 43, text: '    m = recall(k)' },
      ],
    })
  })

  test('diffs old_string against new_string when there is no result yet', () => {
    const diff = toolDiff('Edit', JSON.stringify({ file_path: '/w/a', old_string: 'a\nb\n', new_string: 'a\nc\n' }))
    expect(diff?.added).toBe(1)
    expect(diff?.removed).toBe(1)
    expect(diff?.rows.filter(r => r.kind !== 'hunk').map(r => `${r.kind}:${r.text}`)).toEqual(['ctx:a', 'del:b', 'add:c'])
  })

  test('joins the hunks of every MultiEdit edit', () => {
    const diff = toolDiff(
      'MultiEdit',
      JSON.stringify({ file_path: '/w/a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }),
    )
    expect(diff?.rows.filter(r => r.kind === 'hunk')).toHaveLength(2)
    expect([diff?.added, diff?.removed]).toEqual([2, 2])
  })

  test('shows a new file as added lines', () => {
    const diff = toolDiff('Write', JSON.stringify({ file_path: '/w/n.md', content: '# T\n\nbody\n' }), {
      type: 'create',
      structuredPatch: [],
    })
    expect(diff).toEqual({
      added: 3,
      removed: 0,
      created: true,
      rows: [
        { kind: 'add', new: 1, text: '# T' },
        { kind: 'add', new: 2, text: '' },
        { kind: 'add', new: 3, text: 'body' },
      ],
    })
  })

  test('has no diff for other tools or incomplete input', () => {
    expect(toolDiff('Bash', JSON.stringify({ command: 'ls' }))).toBeUndefined()
    expect(toolDiff('Edit', '{"file_path": "/w/a", "old_')).toBeUndefined()
    expect(toolDiff('Write', JSON.stringify({ file_path: '/w/a', content: 'x' }), { type: 'update', structuredPatch: [] })).toBeUndefined()
  })
})
