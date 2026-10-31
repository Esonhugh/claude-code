import { getInitialSettings } from './settings/settings.js'

// Official 2.1.303 `timeFormat` / `timeZone` settings: a preset or a strftime
// pattern (any value containing "%") for clock times shown in the UI.
export const TIME_FORMAT_PRESETS = [
  'auto',
  '12-hour',
  '24-hour',
  '24-hour-utc',
] as const
export type TimeFormatPreset = (typeof TIME_FORMAT_PRESETS)[number]

export type ResolvedTimeFormat =
  | { kind: 'preset'; preset: TimeFormatPreset; timeZone: string | undefined }
  | { kind: 'pattern'; pattern: string; timeZone: string | undefined }

const MAX_PATTERN_LENGTH = 100

export function sanitizeTimeFormat(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_PATTERN_LENGTH)
}

function validTimeZone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return undefined
  }
}

export function resolveTimeFormat(
  timeFormat: string | undefined,
  timeZone: string | undefined,
): ResolvedTimeFormat {
  const preset = TIME_FORMAT_PRESETS.find(p => p === timeFormat)
  if (preset === '24-hour-utc') return { kind: 'preset', preset, timeZone: 'UTC' }
  const zone = validTimeZone(timeZone)
  if (preset) return { kind: 'preset', preset, timeZone: zone }
  const pattern = sanitizeTimeFormat(timeFormat ?? '')
  return pattern.includes('%')
    ? { kind: 'pattern', pattern, timeZone: zone }
    : { kind: 'preset', preset: 'auto', timeZone: zone }
}

export function getTimeFormatSetting(): ResolvedTimeFormat {
  const settings = getInitialSettings()
  return resolveTimeFormat(settings.timeFormat, settings.timeZone)
}

const localeCache = new Map<string, string | undefined>()

/** Locale from LC_ALL / LC_TIME / LANG, used for %a %A %b %B names. */
export function getTimeLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || ''
  if (localeCache.has(raw)) return localeCache.get(raw)
  let locale: string | undefined
  const tag = raw.split('.')[0]?.split('@')[0]
  if (raw && raw !== 'C' && raw !== 'POSIX' && tag) {
    try {
      new Intl.DateTimeFormat(tag.replaceAll('_', '-'))
      locale = tag.replaceAll('_', '-')
    } catch {
      locale = undefined
    }
  }
  localeCache.set(raw, locale)
  return locale
}

function withTimeZone(
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormatOptions {
  return timeZone ? { ...options, timeZone } : options
}

function presetOptions(
  options: Intl.DateTimeFormatOptions,
  preset: TimeFormatPreset,
  timeZone: string | undefined,
): Intl.DateTimeFormatOptions {
  switch (preset) {
    case 'auto':
      return withTimeZone(options, timeZone)
    case '12-hour':
      return withTimeZone({ ...options, hourCycle: 'h12' }, timeZone)
    case '24-hour':
    case '24-hour-utc':
      return withTimeZone({ ...options, hourCycle: 'h23' }, timeZone)
  }
}

const pad = (n: number, raw: string) => (raw ? String(n) : String(n).padStart(2, '0'))
const padSpace = (n: number, raw: string) => (raw ? String(n) : String(n).padStart(2, ' '))

export function strftime(
  pattern: string,
  date: Date,
  { locale, timeZone }: { locale?: string; timeZone?: string },
): string {
  const parts: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat(
    'en-US',
    withTimeZone(
      {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
      },
      timeZone,
    ),
  ).formatToParts(date)) {
    parts[part.type] = part.value
  }
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const hour = Number(parts.hour)
  const minute = Number(parts.minute)
  const second = Number(parts.second)
  const hour12 = ((hour + 11) % 12) + 1
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const name = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, withTimeZone({ ...options, calendar: 'gregory' }, timeZone)).format(date)
  const offset = () => {
    const local = Date.UTC(year, month - 1, day, hour, minute, second)
    const minutes = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
    const abs = Math.abs(minutes)
    return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
  }

  return pattern.replace(/%(-?)([\s\S])/g, (match, raw: string, spec: string) => {
    switch (spec) {
      case 'Y': return String(year)
      case 'y': return pad(year % 100, raw)
      case 'C': return pad(Math.floor(year / 100), raw)
      case 'm': return pad(month, raw)
      case 'd': return pad(day, raw)
      case 'e': return padSpace(day, raw)
      case 'j': {
        const dayOfYear = (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000 + 1
        return raw ? String(dayOfYear) : String(dayOfYear).padStart(3, '0')
      }
      case 'u': return String(weekday === 0 ? 7 : weekday)
      case 'w': return String(weekday)
      case 'H': return pad(hour, raw)
      case 'k': return padSpace(hour, raw)
      case 'I': return pad(hour12, raw)
      case 'l': return padSpace(hour12, raw)
      case 'M': return pad(minute, raw)
      case 'S': return pad(second, raw)
      case 'p': return hour < 12 ? 'AM' : 'PM'
      case 'P': return hour < 12 ? 'am' : 'pm'
      case 's': return String(Math.floor(date.getTime() / 1000))
      case 'a': return name({ weekday: 'short' })
      case 'A': return name({ weekday: 'long' })
      case 'b':
      case 'h': return name({ month: 'short' })
      case 'B': return name({ month: 'long' })
      case 'Z': return parts.timeZoneName ?? ''
      case 'z': return offset()
      case 'F': return `${year}-${pad(month, '')}-${pad(day, '')}`
      case 'D': return `${pad(month, '')}/${pad(day, '')}/${pad(year % 100, '')}`
      case 'T': return `${pad(hour, '')}:${parts.minute}:${parts.second}`
      case 'R': return `${pad(hour, '')}:${parts.minute}`
      case 'r': return `${pad(hour12, '')}:${parts.minute}:${parts.second} ${hour < 12 ? 'AM' : 'PM'}`
      case '%': return '%'
      default: return match
    }
  })
}

function formatPattern(format: Extract<ResolvedTimeFormat, { kind: 'pattern' }>, date: Date, locale: string | undefined): string {
  return sanitizeTimeFormat(strftime(format.pattern, date, { locale, timeZone: format.timeZone }))
}

/** Clock time such as a message timestamp ("02:05 PM", "14:05", "14:05Z"). */
export function formatClockTime(
  date: Date,
  format: ResolvedTimeFormat = getTimeFormatSetting(),
  locale: string | undefined = getTimeLocale(),
): string {
  if (format.kind === 'pattern') return formatPattern(format, date, locale)
  const formatter = new Intl.DateTimeFormat(
    'en-US',
    presetOptions({ hour: '2-digit', minute: '2-digit', hourCycle: 'h12' }, format.preset, format.timeZone),
  )
  if (format.preset !== '24-hour-utc') return formatter.format(date)
  const parts = formatter.formatToParts(date)
  const last = parts.findLastIndex(part => part.type === 'minute' || part.type === 'second')
  return parts.map((part, i) => (i === last ? `${part.value}Z` : part.value)).join('')
}

const DONE_AT_OPTIONS = {
  today: { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
  week: { weekday: 'long', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
  older: { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
} satisfies Record<string, Intl.DateTimeFormatOptions>
const DONE_AT_DATE_OPTIONS = {
  week: { weekday: 'long' },
  older: { weekday: 'long', month: 'short', day: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>

function dayNumber(date: Date, timeZone: string | undefined): number {
  if (!timeZone) return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone })
      .formatToParts(date)
      .map(part => [part.type, part.value]),
  )
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
}

/** When a turn finished, like official 2.1.311 "done 3:23 AM" / "done Monday 3:23 AM". */
export function formatDoneAt(
  timestamp: string,
  now: Date = new Date(),
  format: ResolvedTimeFormat = getTimeFormatSetting(),
  locale: string | undefined = getTimeLocale(),
): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.round((dayNumber(now, format.timeZone) - dayNumber(date, format.timeZone)) / 86_400_000)
  const age = days === 0 ? 'today' : days > 0 && days < 7 ? 'week' : 'older'
  if (format.kind === 'preset') {
    const formatter = new Intl.DateTimeFormat(locale, presetOptions(DONE_AT_OPTIONS[age], format.preset, format.timeZone))
    if (format.preset !== '24-hour-utc') return formatter.format(date)
    const parts = formatter.formatToParts(date)
    const last = parts.findLastIndex(part => part.type === 'minute' || part.type === 'second')
    return parts.map((part, i) => (i === last ? `${part.value}Z` : part.value)).join('')
  }
  const time = formatPattern(format, date, locale)
  if (age === 'today') return time
  const day = new Intl.DateTimeFormat(locale, withTimeZone(DONE_AT_DATE_OPTIONS[age], format.timeZone)).format(date)
  return age === 'week' ? `${day} ${time}` : `${day}, ${time}`
}
