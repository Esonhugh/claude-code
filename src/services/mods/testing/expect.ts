import { AssertionError } from 'node:assert'
import { inspect } from 'node:util'

export type AsymmetricMatcher = {
  readonly text: string
}

export type Constructor = abstract new (...args: never[]) => unknown

export type ThrowExpectation = string | RegExp | Constructor | WithMessage

export type WithMessage = {
  message: string
}

export type Matchers = {
  toBe: (expected: unknown) => void
  toEqual: (expected: unknown) => void
  toStrictEqual: (expected: unknown) => void
  toMatchObject: (expected: object) => void
  toContain: (item: unknown) => void
  toContainEqual: (item: unknown) => void
  toHaveLength: (length: number) => void
  toHaveProperty: (path: string | readonly string[], value?: unknown) => void
  toBeUndefined: () => void
  toBeDefined: () => void
  toBeNull: () => void
  toBeTruthy: () => void
  toBeFalsy: () => void
  toBeNaN: () => void
  toBeGreaterThan: (bound: number | bigint) => void
  toBeGreaterThanOrEqual: (bound: number | bigint) => void
  toBeLessThan: (bound: number | bigint) => void
  toBeLessThanOrEqual: (bound: number | bigint) => void
  toMatch: (pattern: string | RegExp) => void
  toStartWith: (prefix: string) => void
  toEndWith: (suffix: string) => void
  toBeInstanceOf: (expected: Constructor) => void
  toThrow: (expected?: ThrowExpectation) => void
}

export type AsyncMatchers = {
  [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void>
}

export type Negatable<M> = M & {
  not: M
}

export type Expectation = Negatable<Matchers> & {
  resolves: Negatable<AsyncMatchers>
  rejects: Negatable<AsyncMatchers>
}

export type Expecting = (received: unknown, message?: string) => Expectation

export type Matching = {
  any: (expected: Constructor) => AsymmetricMatcher
  anything: () => AsymmetricMatcher
  stringContaining: (text: string) => AsymmetricMatcher
  stringMatching: (pattern: string | RegExp) => AsymmetricMatcher
  objectContaining: (shape: object) => AsymmetricMatcher
  arrayContaining: (items: readonly unknown[]) => AsymmetricMatcher
}

export type Expect = Expecting & Matching

type CompareContext = {
  pairs: Array<readonly [object, object]>
}

type InternalAsymmetricMatcher = AsymmetricMatcher & {
  readonly [ASYMMETRIC]: (
    received: unknown,
    context: CompareContext,
  ) => boolean
}

type MatcherResult = {
  pass: boolean
  actual: unknown
  expected: unknown
  expectedLabel?: string
  detail?: string
}

type PromiseMode = 'resolves' | 'rejects'

type MatcherName = keyof Matchers

const ASYMMETRIC = Symbol('claude-code.testing.asymmetricMatcher')
const objectToString = Object.prototype.toString

const matcherNames: readonly MatcherName[] = [
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toBeUndefined',
  'toBeDefined',
  'toBeNull',
  'toBeTruthy',
  'toBeFalsy',
  'toBeNaN',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toMatch',
  'toStartWith',
  'toEndWith',
  'toBeInstanceOf',
  'toThrow',
]

function newCompareContext(): CompareContext {
  return { pairs: [] }
}

function cloneCompareContext(context: CompareContext): CompareContext {
  return { pairs: [...context.pairs] }
}

function commitCompareContext(
  target: CompareContext,
  source: CompareContext,
): void {
  target.pairs = source.pairs
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isAsymmetricMatcher(value: unknown): value is InternalAsymmetricMatcher {
  return isObject(value) && typeof (value as Partial<InternalAsymmetricMatcher>)[ASYMMETRIC] === 'function'
}

function registerPair(
  received: object,
  expected: object,
  context: CompareContext,
): boolean | undefined {
  for (const [knownReceived, knownExpected] of context.pairs) {
    if (knownReceived === received && knownExpected === expected) return true
  }
  context.pairs.push([received, expected])
  return undefined
}

function enumerableKeys(value: object, ignoreUndefined: boolean): PropertyKey[] {
  return Reflect.ownKeys(value).filter(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable) return false
    return !ignoreUndefined || (value as Record<PropertyKey, unknown>)[key] !== undefined
  })
}

function sameKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return left.length === right.length && left.every(key => right.includes(key))
}

function compareProperties(
  received: object,
  expected: object,
  strict: boolean,
  context: CompareContext,
): boolean {
  const receivedKeys = enumerableKeys(received, !strict)
  const expectedKeys = enumerableKeys(expected, !strict)
  if (!sameKeys(receivedKeys, expectedKeys)) return false
  return expectedKeys.every(key => compare(
    (received as Record<PropertyKey, unknown>)[key],
    (expected as Record<PropertyKey, unknown>)[key],
    strict,
    context,
  ))
}

function comparePartial(
  received: unknown,
  expected: object,
  strict: boolean,
  context: CompareContext,
): boolean {
  if (!isObject(received)) return false
  const known = registerPair(received, expected, context)
  if (known !== undefined) return known
  if (strict && Object.getPrototypeOf(received) !== Object.getPrototypeOf(expected)) return false

  for (const key of enumerableKeys(expected, false)) {
    if (!(key in received)) return false
    const receivedValue = (received as Record<PropertyKey, unknown>)[key]
    const expectedValue = (expected as Record<PropertyKey, unknown>)[key]
    if (
      isObject(expectedValue) &&
      !isAsymmetricMatcher(expectedValue) &&
      objectToString.call(expectedValue) === '[object Object]'
    ) {
      if (!comparePartial(receivedValue, expectedValue, strict, context)) return false
    } else if (!compare(receivedValue, expectedValue, strict, context)) {
      return false
    }
  }
  return true
}

function compareMaps(
  received: Map<unknown, unknown>,
  expected: Map<unknown, unknown>,
  strict: boolean,
  context: CompareContext,
): boolean {
  if (received.size !== expected.size) return false
  const remaining = [...received.entries()]
  for (const [expectedKey, expectedValue] of expected) {
    let found = -1
    let matchedContext: CompareContext | undefined
    for (let index = 0; index < remaining.length; index += 1) {
      const candidateContext = cloneCompareContext(context)
      const [receivedKey, receivedValue] = remaining[index]!
      if (
        compare(receivedKey, expectedKey, strict, candidateContext) &&
        compare(receivedValue, expectedValue, strict, candidateContext)
      ) {
        found = index
        matchedContext = candidateContext
        break
      }
    }
    if (found < 0 || !matchedContext) return false
    remaining.splice(found, 1)
    commitCompareContext(context, matchedContext)
  }
  return true
}

function compareSets(
  received: Set<unknown>,
  expected: Set<unknown>,
  strict: boolean,
  context: CompareContext,
): boolean {
  if (received.size !== expected.size) return false
  const remaining = [...received]
  for (const expectedItem of expected) {
    let found = -1
    let matchedContext: CompareContext | undefined
    for (let index = 0; index < remaining.length; index += 1) {
      const candidateContext = cloneCompareContext(context)
      if (compare(remaining[index], expectedItem, strict, candidateContext)) {
        found = index
        matchedContext = candidateContext
        break
      }
    }
    if (found < 0 || !matchedContext) return false
    remaining.splice(found, 1)
    commitCompareContext(context, matchedContext)
  }
  return true
}

function compareArrayBuffers(received: ArrayBuffer, expected: ArrayBuffer): boolean {
  if (received.byteLength !== expected.byteLength) return false
  const left = new Uint8Array(received)
  const right = new Uint8Array(expected)
  return left.every((value, index) => value === right[index])
}

function compareViews(received: ArrayBufferView, expected: ArrayBufferView): boolean {
  if (received.byteLength !== expected.byteLength) return false
  const left = new Uint8Array(received.buffer, received.byteOffset, received.byteLength)
  const right = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength)
  return left.every((value, index) => value === right[index])
}

function compare(
  received: unknown,
  expected: unknown,
  strict: boolean,
  context: CompareContext,
): boolean {
  if (isAsymmetricMatcher(expected)) return expected[ASYMMETRIC](received, context)
  if (Object.is(received, expected)) return true
  if (!isObject(received) || !isObject(expected)) return false
  if (typeof received === 'function' || typeof expected === 'function') return false

  const known = registerPair(received, expected, context)
  if (known !== undefined) return known
  if (strict && Object.getPrototypeOf(received) !== Object.getPrototypeOf(expected)) return false

  const receivedTag = objectToString.call(received)
  const expectedTag = objectToString.call(expected)
  if (receivedTag !== expectedTag) return false

  if (received instanceof Date && expected instanceof Date) {
    return Object.is(received.getTime(), expected.getTime())
  }
  if (received instanceof RegExp && expected instanceof RegExp) {
    return received.source === expected.source && received.flags === expected.flags
  }
  if (received instanceof Map && expected instanceof Map) {
    return compareMaps(received, expected, strict, context)
  }
  if (received instanceof Set && expected instanceof Set) {
    return compareSets(received, expected, strict, context)
  }
  if (received instanceof ArrayBuffer && expected instanceof ArrayBuffer) {
    return compareArrayBuffers(received, expected)
  }
  if (ArrayBuffer.isView(received) && ArrayBuffer.isView(expected)) {
    if (strict && received.constructor !== expected.constructor) return false
    return compareViews(received, expected)
  }
  if (
    receivedTag === '[object Number]' ||
    receivedTag === '[object String]' ||
    receivedTag === '[object Boolean]' ||
    receivedTag === '[object BigInt]' ||
    receivedTag === '[object Symbol]'
  ) {
    if (!Object.is(
      (received as { valueOf: () => unknown }).valueOf(),
      (expected as { valueOf: () => unknown }).valueOf(),
    )) return false
  }
  if (received instanceof Error && expected instanceof Error) {
    if (received.name !== expected.name || received.message !== expected.message) return false
  }
  if (
    receivedTag === '[object Promise]' ||
    receivedTag === '[object WeakMap]' ||
    receivedTag === '[object WeakSet]'
  ) return false
  if (Array.isArray(received) && Array.isArray(expected) && received.length !== expected.length) {
    return false
  }

  return compareProperties(received, expected, strict, context)
}

function deepEqual(received: unknown, expected: unknown, strict = false): boolean {
  return compare(received, expected, strict, newCompareContext())
}

function regexpMatches(pattern: RegExp, value: string): boolean {
  return new RegExp(pattern.source, pattern.flags).test(value)
}

function constructorName(expected: Constructor): string {
  return (expected as Constructor & { name?: string }).name || '<anonymous>'
}

function matchesConstructor(received: unknown, expected: Constructor): boolean {
  if (expected === String) return typeof received === 'string' || received instanceof String
  if (expected === Number) return typeof received === 'number' || received instanceof Number
  if (expected === Boolean) return typeof received === 'boolean' || received instanceof Boolean
  if (expected === (BigInt as unknown)) return typeof received === 'bigint' || objectToString.call(received) === '[object BigInt]'
  if (expected === (Symbol as unknown)) return typeof received === 'symbol' || objectToString.call(received) === '[object Symbol]'
  if (expected === Function) return typeof received === 'function'
  if (expected === Object) return received !== null && (typeof received === 'object' || typeof received === 'function')
  try {
    return received instanceof expected
  } catch {
    return false
  }
}

function makeAsymmetricMatcher(
  text: string,
  predicate: InternalAsymmetricMatcher[typeof ASYMMETRIC],
): AsymmetricMatcher {
  return Object.freeze({
    text,
    [ASYMMETRIC]: predicate,
    [inspect.custom]: () => text,
  })
}

function formatValue(value: unknown): string {
  return inspect(value, {
    breakLength: 80,
    depth: 8,
    maxArrayLength: 50,
    maxStringLength: 2_000,
  })
}

function contains(received: unknown, item: unknown, equal: boolean): boolean {
  if (typeof received === 'string') {
    return !equal && typeof item === 'string' && received.includes(item)
  }
  if (received === null || received === undefined) return false
  const iterator = (Object(received) as { [Symbol.iterator]?: unknown })[Symbol.iterator]
  if (typeof iterator !== 'function') return false
  for (const candidate of received as Iterable<unknown>) {
    if (equal ? deepEqual(candidate, item) : Object.is(candidate, item)) return true
  }
  return false
}

function readProperty(
  received: unknown,
  path: string | readonly string[],
): { found: boolean; value: unknown } {
  const keys = typeof path === 'string' ? path.split('.') : path
  let current = received
  for (const key of keys) {
    if (current === null || current === undefined) return { found: false, value: undefined }
    const object = Object(current) as Record<string, unknown>
    if (!(key in object)) return { found: false, value: undefined }
    current = object[key]
  }
  return { found: true, value: current }
}

function numericComparison(
  received: unknown,
  bound: unknown,
  operator: '>' | '>=' | '<' | '<=',
): boolean {
  if (
    (typeof received !== 'number' && typeof received !== 'bigint') ||
    (typeof bound !== 'number' && typeof bound !== 'bigint')
  ) return false
  if (typeof received === 'number' && Number.isNaN(received)) return false
  if (typeof bound === 'number' && Number.isNaN(bound)) return false

  if (operator === '>') return received > bound
  if (operator === '>=') return received >= bound
  if (operator === '<') return received < bound
  return received <= bound
}

function thrownMessage(thrown: unknown): string {
  if (isObject(thrown) && 'message' in thrown && typeof thrown.message === 'string') {
    return thrown.message
  }
  return String(thrown)
}

function matchesThrown(thrown: unknown, expected: ThrowExpectation | undefined): boolean {
  if (expected === undefined) return true
  const message = thrownMessage(thrown)
  if (typeof expected === 'string') return message.includes(expected)
  if (expected instanceof RegExp) return regexpMatches(expected, message)
  if (typeof expected === 'function') return matchesConstructor(thrown, expected)
  return message === expected.message
}

function invokeThrow(received: unknown, fromRejection: boolean): { threw: boolean; value: unknown } {
  if (fromRejection) return { threw: true, value: received }
  if (typeof received !== 'function') return { threw: false, value: received }
  try {
    received()
    return { threw: false, value: undefined }
  } catch (error) {
    return { threw: true, value: error }
  }
}

function result(
  pass: boolean,
  actual: unknown,
  expected: unknown,
  expectedLabel?: string,
  detail?: string,
): MatcherResult {
  return { pass, actual, expected, expectedLabel, detail }
}

function evaluateMatcher(
  name: MatcherName,
  received: unknown,
  args: readonly unknown[],
  fromRejection: boolean,
): MatcherResult {
  const expected = args[0]
  switch (name) {
    case 'toBe':
      return result(Object.is(received, expected), received, expected)
    case 'toEqual':
      return result(deepEqual(received, expected), received, expected)
    case 'toStrictEqual':
      return result(deepEqual(received, expected, true), received, expected)
    case 'toMatchObject':
      return result(
        isObject(expected) && comparePartial(received, expected, false, newCompareContext()),
        received,
        expected,
      )
    case 'toContain':
      return result(contains(received, expected, false), received, expected)
    case 'toContainEqual':
      return result(contains(received, expected, true), received, expected)
    case 'toHaveLength': {
      const length = isObject(received) || typeof received === 'string'
        ? (received as { length?: unknown }).length
        : undefined
      return result(length === expected, length, expected)
    }
    case 'toHaveProperty': {
      const property = readProperty(received, expected as string | readonly string[])
      if (args.length < 2) {
        return result(property.found, received, expected, `property ${formatValue(expected)}`)
      }
      return result(
        property.found && deepEqual(property.value, args[1]),
        property.value,
        args[1],
        undefined,
        `Property: ${formatValue(expected)}`,
      )
    }
    case 'toBeUndefined':
      return result(received === undefined, received, undefined)
    case 'toBeDefined':
      return result(received !== undefined, received, 'defined value', 'a defined value')
    case 'toBeNull':
      return result(received === null, received, null)
    case 'toBeTruthy':
      return result(Boolean(received), received, 'truthy value', 'a truthy value')
    case 'toBeFalsy':
      return result(!received, received, 'falsy value', 'a falsy value')
    case 'toBeNaN':
      return result(typeof received === 'number' && Number.isNaN(received), received, Number.NaN)
    case 'toBeGreaterThan':
      return result(numericComparison(received, expected, '>'), received, expected)
    case 'toBeGreaterThanOrEqual':
      return result(numericComparison(received, expected, '>='), received, expected)
    case 'toBeLessThan':
      return result(numericComparison(received, expected, '<'), received, expected)
    case 'toBeLessThanOrEqual':
      return result(numericComparison(received, expected, '<='), received, expected)
    case 'toMatch':
      return result(
        typeof received === 'string' && (
          typeof expected === 'string'
            ? received.includes(expected)
            : expected instanceof RegExp && regexpMatches(expected, received)
        ),
        received,
        expected,
      )
    case 'toStartWith':
      return result(
        typeof received === 'string' && typeof expected === 'string' && received.startsWith(expected),
        received,
        expected,
      )
    case 'toEndWith':
      return result(
        typeof received === 'string' && typeof expected === 'string' && received.endsWith(expected),
        received,
        expected,
      )
    case 'toBeInstanceOf':
      return result(
        typeof expected === 'function' && matchesConstructor(received, expected as Constructor),
        received,
        expected,
        typeof expected === 'function' ? constructorName(expected as Constructor) : formatValue(expected),
      )
    case 'toThrow': {
      const thrown = invokeThrow(received, fromRejection)
      const pass = thrown.threw && matchesThrown(thrown.value, expected as ThrowExpectation | undefined)
      const label = expected === undefined
        ? 'a thrown value'
        : expected instanceof RegExp
          ? formatValue(expected)
          : typeof expected === 'function'
            ? constructorName(expected as Constructor)
            : typeof expected === 'string'
              ? `message containing ${formatValue(expected)}`
              : `message ${formatValue((expected as WithMessage).message)}`
      return result(pass, thrown.value, expected, label)
    }
  }
}

function assertionFailure(
  name: MatcherName,
  matcherResult: MatcherResult,
  negated: boolean,
  message: string | undefined,
  stackStartFn: (...args: unknown[]) => unknown,
): never {
  const expected = matcherResult.expectedLabel ?? formatValue(matcherResult.expected)
  const lines = [
    `${message ? `${message}\n\n` : ''}expect(received).${negated ? 'not.' : ''}${name}(expected)`,
    '',
    `Expected: ${negated ? 'not ' : ''}${expected}`,
    `Received: ${formatValue(matcherResult.actual)}`,
  ]
  if (matcherResult.detail) lines.push(matcherResult.detail)
  throw new AssertionError({
    actual: matcherResult.actual,
    expected: matcherResult.expected,
    message: lines.join('\n'),
    operator: `${negated ? 'not.' : ''}${name}`,
    stackStartFn,
  })
}

function runMatcher(
  name: MatcherName,
  received: unknown,
  args: readonly unknown[],
  negated: boolean,
  message: string | undefined,
  fromRejection: boolean,
  stackStartFn: (...args: unknown[]) => unknown,
): void {
  const matcherResult = evaluateMatcher(name, received, args, fromRejection)
  if (negated ? matcherResult.pass : !matcherResult.pass) {
    assertionFailure(name, matcherResult, negated, message, stackStartFn)
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (!isObject(value)) return false
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return false
  }
}

async function runAsyncMatcher(
  name: MatcherName,
  received: unknown,
  args: readonly unknown[],
  negated: boolean,
  message: string | undefined,
  mode: PromiseMode,
  stackStartFn: (...args: unknown[]) => unknown,
): Promise<void> {
  if (!isPromiseLike(received)) {
    assertionFailure(
      name,
      result(false, received, mode === 'resolves' ? 'a promise that resolves' : 'a promise that rejects', 'a promise'),
      negated,
      message,
      stackStartFn,
    )
  }

  let fulfilled = false
  let settled: unknown
  try {
    settled = await received
    fulfilled = true
  } catch (error) {
    settled = error
  }

  if (mode === 'resolves' && !fulfilled) {
    assertionFailure(
      name,
      result(false, settled, 'a resolved promise', 'a promise that resolves', 'The promise rejected instead.'),
      negated,
      message,
      stackStartFn,
    )
  }
  if (mode === 'rejects' && fulfilled) {
    assertionFailure(
      name,
      result(false, settled, 'a rejected promise', 'a promise that rejects', 'The promise resolved instead.'),
      negated,
      message,
      stackStartFn,
    )
  }

  runMatcher(name, settled, args, negated, message, mode === 'rejects', stackStartFn)
}

function makeSyncMatchers(
  received: unknown,
  message: string | undefined,
  negated: boolean,
): Matchers {
  const matchers = {} as Record<MatcherName, (...args: unknown[]) => void>
  for (const name of matcherNames) {
    matchers[name] = function matcherCall(...args: unknown[]): void {
      runMatcher(name, received, args, negated, message, false, matcherCall)
    }
  }
  return matchers as Matchers
}

function makeAsyncMatchers(
  received: unknown,
  message: string | undefined,
  mode: PromiseMode,
  negated: boolean,
): AsyncMatchers {
  const matchers = {} as Record<MatcherName, (...args: unknown[]) => Promise<void>>
  for (const name of matcherNames) {
    matchers[name] = async function matcherCall(...args: unknown[]): Promise<void> {
      await runAsyncMatcher(name, received, args, negated, message, mode, matcherCall)
    }
  }
  return matchers as AsyncMatchers
}

const expecting: Expecting = (received, message) => {
  const positive = makeSyncMatchers(received, message, false)
  const negative = makeSyncMatchers(received, message, true)
  const resolves = makeAsyncMatchers(received, message, 'resolves', false)
  const resolvesNot = makeAsyncMatchers(received, message, 'resolves', true)
  const rejects = makeAsyncMatchers(received, message, 'rejects', false)
  const rejectsNot = makeAsyncMatchers(received, message, 'rejects', true)

  return Object.assign(positive, {
    not: negative,
    resolves: Object.assign(resolves, { not: resolvesNot }),
    rejects: Object.assign(rejects, { not: rejectsNot }),
  })
}

const matching: Matching = {
  any(expected) {
    return makeAsymmetricMatcher(
      `expect.any(${constructorName(expected)})`,
      received => matchesConstructor(received, expected),
    )
  },
  anything() {
    return makeAsymmetricMatcher(
      'expect.anything()',
      received => received !== null && received !== undefined,
    )
  },
  stringContaining(text) {
    return makeAsymmetricMatcher(
      `expect.stringContaining(${formatValue(text)})`,
      received => typeof received === 'string' && received.includes(text),
    )
  },
  stringMatching(pattern) {
    const expression = typeof pattern === 'string' ? new RegExp(pattern) : pattern
    return makeAsymmetricMatcher(
      `expect.stringMatching(${formatValue(pattern)})`,
      received => typeof received === 'string' && regexpMatches(expression, received),
    )
  },
  objectContaining(shape) {
    return makeAsymmetricMatcher(
      `expect.objectContaining(${formatValue(shape)})`,
      (received, context) => comparePartial(received, shape, false, context),
    )
  },
  arrayContaining(items) {
    return makeAsymmetricMatcher(
      `expect.arrayContaining(${formatValue(items)})`,
      (received, context) => Array.isArray(received) && items.every(item =>
        received.some(candidate => compare(
          candidate,
          item,
          false,
          cloneCompareContext(context),
        )),
      ),
    )
  },
}

export const expect: Expect = Object.assign(expecting, matching)
