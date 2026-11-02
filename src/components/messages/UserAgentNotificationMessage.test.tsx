import { expect, test } from 'bun:test'
import * as React from 'react'
import { buildMonitorEventNotification } from '../../tools/MonitorTool/monitorEvents.js'
import { renderToString } from '../../utils/staticRender.js'
import { UserAgentNotificationMessage } from './UserAgentNotificationMessage.js'

test('monitor events show the first event line before the description', async () => {
  const text = buildMonitorEventNotification(
    'b1',
    'app.log errors',
    'ERROR db connection refused\nERROR second line',
  )
  const drawn = await renderToString(
    <UserAgentNotificationMessage addMargin={false} param={{ type: 'text', text }} />,
  )
  expect(drawn.trim()).toBe('● Monitor event: ERROR db connection refused · app.log errors')
})

test('other task notifications show their summary', async () => {
  const text = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "scan" finished</summary>\n</task-notification>'
  const drawn = await renderToString(
    <UserAgentNotificationMessage addMargin={false} param={{ type: 'text', text }} />,
  )
  expect(drawn.trim()).toBe('● Agent "scan" finished')
})

test('task notifications with usage show their duration after the summary', async () => {
  const text = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "scan" finished</summary>\n<usage><total_tokens>15</total_tokens><tool_uses>1</tool_uses><duration_ms>4012</duration_ms></usage>\n</task-notification>'
  const drawn = await renderToString(
    <UserAgentNotificationMessage addMargin={false} param={{ type: 'text', text }} />,
  )
  expect(drawn.trim()).toBe('● Agent "scan" finished · 4s')
})
