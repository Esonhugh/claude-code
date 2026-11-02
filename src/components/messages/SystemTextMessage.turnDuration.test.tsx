import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const configDir = mkdtempSync(join(tmpdir(), 'turn-duration-test-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const { AppStoreContext, getDefaultAppState } = await import('../../state/AppState.js')
const { createStore } = await import('../../state/store.js')
const { createTurnDurationMessage } = await import('../../utils/messages.js')
const { formatDoneAt } = await import('../../utils/timeFormat.js')
const { renderToString } = await import('../../utils/staticRender.js')
const { SystemTextMessage } = await import('./SystemTextMessage.js')

const agent = (status: string, notified = false) => ({
  id: 'a1', type: 'local_agent', status, isBackgrounded: true, notified, description: 'scan', agentType: 'general-purpose',
})

async function draw(message: ReturnType<typeof createTurnDurationMessage>, tasks: Record<string, unknown>) {
  const store = createStore({ ...getDefaultAppState(), tasks } as never)
  return (await renderToString(
    <AppStoreContext value={store}>
      <SystemTextMessage message={message} addMargin={false} verbose={false} />
    </AppStoreContext>,
  )).trim()
}

test('a finished turn shows when it was done', async () => {
  const message = createTurnDurationMessage(4_000)
  expect(await draw(message, {})).toMatch(new RegExp(`for 4s · done ${formatDoneAt(message.timestamp)}$`))
})

test('a turn that ended with background agents pending says it is waiting for them', async () => {
  const message = createTurnDurationMessage(300, undefined, undefined, { pendingBackgroundAgentCount: 1 })
  const drawn = await draw(message, { a1: agent('running') })
  expect(drawn).toEndWith('Waiting for 1 background agent to finish')
  expect(drawn).not.toContain('still running')
})

test('a waiting row whose agents already reported shows the normal line', async () => {
  const message = createTurnDurationMessage(300, undefined, undefined, { pendingBackgroundAgentCount: 1 })
  expect(await draw(message, { a1: agent('completed', true) })).not.toContain('Waiting for')
})
