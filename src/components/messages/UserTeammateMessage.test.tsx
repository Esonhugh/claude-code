import { expect, test } from 'bun:test'
import * as React from 'react'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { enableConfigs } from '../../utils/config.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { renderToString } from '../../utils/staticRender.js'
import { createIdleNotification } from '../../utils/teammateMailbox.js'
import { UserTeammateMessage } from './UserTeammateMessage.js'

enableConfigs()
const state = getDefaultAppState()
// the expanded result renders as Markdown, which reads settings from the store
const store = createStore({ ...state, settings: { ...state.settings, syntaxHighlightingDisabled: true } })

const wrap = (body: string) => `<teammate-message teammate_id="mate1" color="blue">\n${body}\n</teammate-message>`
const draw = (body: string, isTranscriptMode = false) =>
  renderToString(
    <AppStoreContext.Provider value={store}>
      <UserTeammateMessage addMargin={false} param={{ type: 'text', text: wrap(body) }} isTranscriptMode={isTranscriptMode} />
    </AppStoreContext.Provider>,
  )

test('an idle notification shows the teammate finished with a result preview', async () => {
  const idle = jsonStringify(createIdleNotification('mate1', { idleReason: 'available', result: 'mate 1 done' }))
  expect((await draw(idle)).trim().split('\n').map(l => l.trim())).toEqual(['● Teammate @mate1 finished', 'mate 1 done'])
})

test('the collapsed preview is capped and the expanded view shows the full result and last DM', async () => {
  const long = `${'a'.repeat(250)}`
  const idle = jsonStringify(createIdleNotification('mate1', { idleReason: 'available', result: long, summary: '[to peer] hi' }))
  const collapsed = await draw(idle)
  expect(collapsed.replace(/\s/g, '')).toBe(`●Teammate@mate1finished${'a'.repeat(200)}…`)
  expect(collapsed).not.toContain('Last DM')
  const expanded = await draw(idle, true)
  expect(expanded).toContain('Last DM: [to peer] hi')
  expect(expanded.replace(/\s/g, '')).toContain('a'.repeat(250))
})

test('failed and interrupted teammates are labelled, and a bare idle notification is just the header', async () => {
  const failed = jsonStringify(createIdleNotification('mate1', { idleReason: 'failed', failureReason: 'boom' }))
  expect((await draw(failed)).trim()).toBe('● Teammate @mate1 failed: boom')
  const interrupted = jsonStringify(createIdleNotification('mate1', { idleReason: 'interrupted' }))
  expect((await draw(interrupted)).trim()).toBe('● Teammate @mate1 was interrupted')
})
