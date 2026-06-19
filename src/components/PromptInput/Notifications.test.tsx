import assert from 'node:assert/strict'
import * as React from 'react'

import { Text } from '../../ink.js'
import { GoalStatusIndicator } from './goalStatusIndicator.js'

const inactive = GoalStatusIndicator({ active: false })
assert.equal(inactive, null)

const active = GoalStatusIndicator({ active: true })
assert.ok(React.isValidElement(active))
assert.equal(active.type, Text)
assert.deepEqual(active.props, {
  color: 'ansi:magentaBright',
  bold: true,
  children: 'Goal is set',
})

console.log('Notifications.test.tsx passed')
