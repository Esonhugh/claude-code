import { expect, test } from 'bun:test'
import { getNotificationMessage } from './PermissionRequest.js'

test('the permission prompt notification names no tool, like 2.1.329', () => {
  for (const name of ['Bash', '']) {
    const confirm = { tool: { userFacingName: () => name }, input: {} }
    expect(getNotificationMessage(confirm as never)).toBe(
      'Claude needs your permission',
    )
  }
})
