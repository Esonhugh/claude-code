import { describe, expect, test } from 'bun:test'
import { formatClockTime, formatDoneAt, resolveTimeFormat, strftime } from './timeFormat.js'

const date = new Date(Date.UTC(2026, 9, 26, 18, 5, 9))

describe('timeFormat', () => {
  test('presets format clock times in the chosen zone', () => {
    expect(formatClockTime(date, resolveTimeFormat('12-hour', 'UTC'))).toBe('06:05 PM')
    expect(formatClockTime(date, resolveTimeFormat('24-hour', 'UTC'))).toBe('18:05')
    expect(formatClockTime(date, resolveTimeFormat('24-hour', 'Asia/Shanghai'))).toBe('02:05')
    expect(formatClockTime(date, resolveTimeFormat('24-hour-utc', 'Asia/Shanghai'))).toBe('18:05Z')
  })

  test('a value with % is a strftime pattern; anything else reads as auto', () => {
    expect(resolveTimeFormat('%H:%M', undefined)).toMatchObject({ kind: 'pattern' })
    expect(resolveTimeFormat('nonsense', 'Not/AZone')).toEqual({
      kind: 'preset',
      preset: 'auto',
      timeZone: undefined,
    })
    expect(formatClockTime(date, resolveTimeFormat('%Y-%m-%d %H:%M:%S', 'UTC'))).toBe(
      '2026-10-26 18:05:09',
    )
  })

  test('strftime covers padding, 12-hour, weekday and offset specifiers', () => {
    const opts = { locale: 'en-US', timeZone: 'Asia/Shanghai' }
    expect(strftime('%-m/%e %l%P %a %b %j %u %z %%', date, opts)).toBe(
      '10/27  2am Tue Oct 300 2 +0800 %',
    )
    expect(strftime('%F %T %r %q', date, { timeZone: 'UTC' })).toBe(
      '2026-10-26 18:05:09 06:05:09 PM %q',
    )
  })

  test('patterns are capped at 100 characters', () => {
    expect(formatClockTime(date, resolveTimeFormat(`%Y${'x'.repeat(200)}`, 'UTC'))).toHaveLength(100)
  })
})

describe('formatDoneAt', () => {
  const at = '2026-10-29T03:23:10.000Z'
  const utc12 = resolveTimeFormat('12-hour', 'UTC')
  test('today shows only the clock time, without a leading zero', () => {
    expect(formatDoneAt(at, new Date('2026-10-29T09:00:00Z'), utc12, 'en-US')).toBe('3:23 AM')
    expect(formatDoneAt(at, new Date('2026-10-29T09:00:00Z'), resolveTimeFormat('24-hour-utc', undefined), 'en-US')).toBe('03:23Z')
  })
  test('earlier days add the weekday, then the date', () => {
    expect(formatDoneAt(at, new Date('2026-10-31T09:00:00Z'), utc12, 'en-US')).toBe('Thursday 3:23 AM')
    expect(formatDoneAt(at, new Date('2026-11-20T09:00:00Z'), utc12, 'en-US')).toBe('Thursday, Oct 29, 3:23 AM')
  })
  test('patterns keep the pattern for the time', () => {
    expect(formatDoneAt(at, new Date('2026-10-31T09:00:00Z'), resolveTimeFormat('%H:%M', 'UTC'), 'en-US')).toBe('Thursday 03:23')
  })
})
