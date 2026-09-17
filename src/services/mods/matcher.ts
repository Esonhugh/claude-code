export type ModMatcher =
  | string
  | number
  | boolean
  | null
  | RegExp
  | readonly ModMatcher[]
  | { readonly [key: string]: ModMatcher }

export function normalizeModMatcher(
  value: unknown,
  seen: Set<object> = new Set(),
): ModMatcher {
  const invalid = (message: string): never => {
    throw new Error(`Invalid mod matcher: ${message}`)
  }
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('numbers must be finite')
    return value
  }
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (!value || typeof value !== 'object') invalid('expected scalar, RegExp, array, or plain object')
  const object = value as object
  if (seen.has(object)) invalid('cycles are unsupported')

  seen.add(object)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (!descriptor || !('value' in descriptor)) invalid('array holes and accessors are unsupported')
          return normalizeModMatcher(descriptor.value, seen)
        }),
      )
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      invalid('objects must have a plain or null prototype')
    }
    const entries: [string, ModMatcher][] = []
    const reserved = new Set(['__proto__', 'prototype', 'constructor'])
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (typeof key !== 'string' || reserved.has(key) || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        invalid('object keys must be enumerable data properties with safe string names')
      }
      entries.push([key as string, normalizeModMatcher(descriptor.value, seen)])
    }
    return Object.freeze(Object.fromEntries(entries))
  } finally {
    seen.delete(object)
  }
}

export function matchesModMatcher(matcher: ModMatcher, value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => matchesModMatcher(matcher, item))
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0
    return matcher.test(String(value))
  }
  if (Array.isArray(matcher)) return matcher.some(item => matchesModMatcher(item, value))
  if (matcher && typeof matcher === 'object') {
    if (!value || typeof value !== 'object') return false
    return Object.entries(matcher).every(([key, item]) =>
      matchesModMatcher(item, (value as Record<string, unknown>)[key]),
    )
  }
  return value === matcher
}

export function isModEventPattern(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const pattern = value.startsWith('!') ? value.slice(1) : value
  return pattern === '*' ||
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(pattern) ||
    /^[A-Za-z_][A-Za-z0-9_]*\.\*$/.test(pattern)
}

export function matchesModEventPattern(pattern: string, event: string): boolean {
  const valid = (value: string) => value === '*' ||
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    /^[A-Za-z_][A-Za-z0-9_]*\.\*$/.test(value)
  const selected = pattern.startsWith('!') ? pattern.slice(1) : pattern
  if (!valid(selected) || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(event)) return false
  const matches = selected === '*' || selected === event ||
    (selected.endsWith('.*') && event.startsWith(selected.slice(0, -1)))
  return pattern.startsWith('!') ? !matches : matches
}
