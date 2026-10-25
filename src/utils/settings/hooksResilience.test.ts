import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettingsFile } from './settings.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-resilience-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function read(settings: unknown) {
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify(settings))
  return readSettingsFile(path)
}

const good = {
  matcher: 'Bash',
  hooks: [{ type: 'command' as const, command: 'ok' }],
}

describe('one bad hooks entry does not invalidate the settings file', () => {
  test('an unknown hook event is dropped with a warning (official 2.1.101)', () => {
    const { settings, errors } = read({
      model: 'opus',
      hooks: { NotAnEvent: [good], PostToolUse: [good] },
    })
    expect(settings?.model).toBe('opus')
    expect(settings?.hooks).toEqual({ PostToolUse: [good] })
    expect(errors).toHaveLength(1)
    expect(errors[0]!.path).toBe('hooks.NotAnEvent')
    expect(errors[0]!.message).toContain('Unknown hook event "NotAnEvent"')
  })

  test('a malformed hook entry is dropped, siblings survive (official 2.1.122)', () => {
    const { settings, errors } = read({
      model: 'opus',
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command' }, { type: 'command', command: 'kept' }],
          },
          { matcher: 'Edit', hooks: 'not-an-array' },
          good,
        ],
        Stop: { not: 'an array' },
      },
    })
    expect(settings?.model).toBe('opus')
    expect(settings?.hooks).toEqual({
      PostToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command', command: 'kept' }] },
        good,
      ],
    })
    expect(errors.map(e => e.path).sort()).toEqual([
      'hooks.PostToolUse.0.hooks.0',
      'hooks.PostToolUse.1',
      'hooks.Stop',
    ])
  })

  test('a malformed PreToolUse/PermissionRequest hook still rejects the file', () => {
    // Such a hook may be what guards the permissions beside it.
    for (const event of ['PreToolUse', 'PermissionRequest']) {
      const { settings, errors } = read({
        permissions: { allow: ['Bash'] },
        hooks: { [event]: [{ matcher: 'Bash', hooks: [{ type: 'command' }] }] },
      })
      expect(settings).toBeNull()
      expect(errors.length).toBeGreaterThan(0)
    }
  })

  test('an unknown event that holds PreToolUse hooks still rejects the file', () => {
    const { settings } = read({
      hooks: { Misnested: { PreToolUse: [good] } },
    })
    expect(settings).toBeNull()
  })
})
