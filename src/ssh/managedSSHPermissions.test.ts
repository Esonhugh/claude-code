import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import {
  extractEditablePermissionOverlay,
  mergePermissionOverlays,
  overlayToPermissionRules,
} from './managedSSHPermissions.js'

describe('managed SSH permission overlay helpers', () => {
  it('merges and canonical-deduplicates editable permission settings', () => {
    const overlay = extractEditablePermissionOverlay([
      {
        permissions: {
          allow: ['Bash(*)', 'Bash', 'Read(//tmp/**)'],
          additionalDirectories: ['/tmp/work', '/tmp/work'],
        },
      },
      {
        permissions: {
          allow: ['Bash', 'Read(//tmp/**)'],
          deny: ['Write(//etc/**)'],
          additionalDirectories: ['/tmp/work', '/opt/project'],
        },
      },
    ])

    assert.deepEqual(overlay.permissions?.allow, ['Bash', 'Read(//tmp/**)'])
    assert.deepEqual(overlay.permissions?.deny, ['Write(//etc/**)'])
    assert.deepEqual(overlay.permissions?.additionalDirectories, [
      '/tmp/work',
      '/opt/project',
    ])
  })

  it('preserves overlay and startup layers in merge order without duplicates', () => {
    const overlay = mergePermissionOverlays([
      { permissions: { ask: ['Bash(npm publish:*)'] } },
      { permissions: { ask: ['Bash(npm publish:*)', 'Bash(npm test:*)'] } },
    ])

    assert.deepEqual(overlay.permissions?.ask, [
      'Bash(npm publish:*)',
      'Bash(npm test:*)',
    ])
  })

  it('exposes overlay rules with sshOverlay source', () => {
    const rules = overlayToPermissionRules({
      permissions: {
        allow: ['Read(//tmp/**)'],
        deny: ['Write(//etc/**)'],
      },
    })

    assert.deepEqual(
      rules.map(rule => [rule.source, rule.ruleBehavior, rule.ruleValue]),
      [
        ['sshOverlay', 'allow', { toolName: 'Read', ruleContent: '//tmp/**' }],
        ['sshOverlay', 'deny', { toolName: 'Write', ruleContent: '//etc/**' }],
      ],
    )
  })
})
