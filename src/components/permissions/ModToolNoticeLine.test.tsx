import { expect, test } from 'bun:test'
import React from 'react'
import { createModToolNotices } from '../../services/mods/uiNotice.js'
import { formatPluginNotice } from '../../services/mods/uiNoticeText.js'
import { renderToString } from '../../utils/staticRender.js'
import { ModToolNoticeLine } from './ModToolNoticeLine.js'

test('formats a notice as the official "<plugin>: <text>" line on one row', () => {
  expect(formatPluginNotice('notice-mod', 'NOTICE_LINE')).toBe('notice-mod: NOTICE_LINE')
  expect(formatPluginNotice('notice-mod', 'a\nb\r c')).toBe('notice-mod: a�b��c')
  expect(formatPluginNotice('', 'x')).toBe('unnamed: x')
})

test('draws the open call notice right-aligned and nothing for other calls', async () => {
  const notices = createModToolNotices()
  const close = notices.open('ask-call', 'notice-mod')
  expect(notices.set('ask-call', 'notice-mod', 'NOTICE_LINE')).toBeUndefined()
  const drawn = await renderToString(<ModToolNoticeLine notices={notices} toolUseID="ask-call" />, 40)
  expect(drawn.split('\n').filter(Boolean)).toEqual([`${' '.repeat(17)}notice-mod: NOTICE_LINE`])
  expect((await renderToString(<ModToolNoticeLine notices={notices} toolUseID="other-call" />, 40)).trim()).toBe('')
  expect((await renderToString(<ModToolNoticeLine notices={undefined} toolUseID="ask-call" />, 40)).trim()).toBe('')
  close()
  expect((await renderToString(<ModToolNoticeLine notices={notices} toolUseID="ask-call" />, 40)).trim()).toBe('')
})
