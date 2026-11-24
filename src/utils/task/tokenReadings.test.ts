import { expect, test } from 'bun:test'

import { forgetTokenReadings, getTokenSamples, noteAgentTaskUpdate, startTokenReadings } from './tokenReadings.js'

const task = (tokenCount: number, extra: { evictAfter?: number } = {}) => ({ id: 'agent', startTime: 1_000, progress: { tokenCount }, ...extra })

// Official 2.1.329: a reading 300ms after the start, then one every 5s, the
// last 16 kept, and the current count last.
test('samples hold one reading per period and end with the current count', () => {
  startTokenReadings('agent', 1_000)
  expect(getTokenSamples(task(0), 1_100)).toEqual([0])
  expect(getTokenSamples(task(0), 11_400)).toEqual([0, 0, 0])
  noteAgentTaskUpdate(task(0), task(15), 11_400)
  expect(getTokenSamples(task(15), 11_400)).toEqual([0, 0, 15])
  expect(getTokenSamples(task(15), 13_900)).toEqual([0, 0, 0, 15])
  expect(getTokenSamples(task(15), 200_000)).toHaveLength(16)
  forgetTokenReadings('agent')
})

test('readings start over when the row goes', () => {
  startTokenReadings('agent', 1_000)
  noteAgentTaskUpdate(task(0), task(15), 11_400)
  noteAgentTaskUpdate(task(15), task(15, { evictAfter: 0 }), 12_000)
  expect(getTokenSamples(task(15), 12_100)).toEqual([15])
  forgetTokenReadings('agent')
})
