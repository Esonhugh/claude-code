import { expect, test } from 'bun:test'
import { visibleMarketplaceTabs } from './DiscoverPlugins.js'

const tabs = [null, 'a', 'b', 'c', 'd', 'e'].map(marketplace => ({ marketplace }))

test('marketplace tabs show the first four and keep the active one visible', () => {
  expect(visibleMarketplaceTabs(tabs, null).map(t => t.marketplace)).toEqual([null, 'a', 'b', 'c'])
  expect(visibleMarketplaceTabs(tabs, 'e').map(t => t.marketplace)).toEqual([null, 'a', 'b', 'e'])
  expect(visibleMarketplaceTabs(tabs, 'b').map(t => t.marketplace)).toEqual([null, 'a', 'b', 'c'])
})
