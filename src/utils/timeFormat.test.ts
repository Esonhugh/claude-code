import { describe, expect, test } from 'bun:test'
import { formatClockTime, resolveTimeFormat, strftime } from './timeFormat.js'

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
