import { expect, mock, test } from 'bun:test'
import type { ReactElement } from 'react'

let compute: (() => Promise<unknown>) | undefined
mock.module('./notifs/useStartupNotification.js', () => ({
  useStartupNotification: (fn: () => Promise<unknown>) => {
    compute = fn
  },
}))
let checkResult: Record<string, unknown> = {}
mock.module('../utils/plugins/officialMarketplaceStartupCheck.js', () => ({
  checkAndInstallOfficialMarketplace: async () => checkResult,
}))

const { useOfficialMarketplaceNotification } = await import('./useOfficialMarketplaceNotification.js')

async function notificationText(result: Record<string, unknown>): Promise<string[]> {
  checkResult = result
  useOfficialMarketplaceNotification()
  const notifs = (await compute!()) as Array<{ jsx: ReactElement<{ children: unknown }> }>
  return notifs.map(n => [n.jsx.props.children].flat().join(''))
}

test('install notifications name Esonhugh-Marketplace, the marketplace the startup check installs', async () => {
  expect(await notificationText({ installed: true, skipped: false })).toEqual([
    '✓ Esonhugh-Marketplace installed · /plugin to see available plugins',
  ])
  expect(await notificationText({ installed: false, skipped: true, reason: 'unknown' })).toEqual([
    'Failed to install Esonhugh-Marketplace · Will retry on next startup',
  ])
})
