import { describe, expect as bunExpect, test } from 'bun:test'
import { AssertionError } from 'node:assert'
import { expect } from './expect'

function caught(body: () => unknown): Error {
  try {
    body()
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected the assertion to fail')
}

async function caughtAsync(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body()
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected the assertion to fail')
}

describe('mod testing expect', () => {
  test('supports identity, deep equality, strict equality, and partial objects', () => {
    expect(Number.NaN).toBe(Number.NaN)
    expect({ a: 1, omitted: undefined }).toEqual({ a: 1 })
    expect(Object.assign(Object.create(null), { a: 1 })).toEqual({ a: 1 })
    expect(new Map([[{ id: 1 }, new Set(['a', 'b'])]])).toEqual(
      new Map([[{ id: 1 }, new Set(['b', 'a'])]]),
    )
    expect({ item: { id: 1, label: 'one' }, other: true }).toMatchObject({
      item: { id: 1 },
    })

    bunExpect(() => expect(0).toBe(-0)).toThrow(AssertionError)
    bunExpect(() => expect({ a: undefined }).toStrictEqual({})).toThrow(AssertionError)
    bunExpect(() => expect(Object.create(null)).toStrictEqual({})).toThrow(AssertionError)
    bunExpect(() => expect({ item: { id: 2 } }).toMatchObject({ item: { id: 1 } })).toThrow(AssertionError)
  })

  test('supports containment, lengths, and property paths', () => {
    expect('alphabet').toContain('pha')
    expect(new Set([1, 2])).toContain(2)
    expect([{ id: 1 }, { id: 2 }]).toContainEqual({ id: 2 })
    expect('three').toHaveLength(5)
    expect({ a: { b: undefined }, 'a.b': 3 }).toHaveProperty(['a', 'b'], undefined)
    expect({ a: { b: 2 } }).toHaveProperty('a.b', 2)
    expect({ a: { b: 2 } }).toHaveProperty('a.b')

    bunExpect(() => expect([{ id: 1 }]).toContain({ id: 1 })).toThrow(AssertionError)
    bunExpect(() => expect({ a: {} }).toHaveProperty('a.b')).toThrow(AssertionError)
    bunExpect(() => expect({ a: { b: 2 } }).toHaveProperty('a.b', 3)).toThrow(AssertionError)
  })

  test('supports definedness, truthiness, NaN, and numeric comparisons', () => {
    expect(undefined).toBeUndefined()
    expect(0).toBeDefined()
    expect(null).toBeNull()
    expect('x').toBeTruthy()
    expect(0).toBeFalsy()
    expect(Number.NaN).toBeNaN()
    expect(3).toBeGreaterThan(2)
    expect(3n).toBeGreaterThanOrEqual(3n)
    expect(2).toBeLessThan(3)
    expect(3n).toBeLessThanOrEqual(3n)

    bunExpect(() => expect(null).toBeDefined()).not.toThrow()
    bunExpect(() => expect(undefined).toBeDefined()).toThrow(AssertionError)
    bunExpect(() => expect(2).toBeGreaterThan(2)).toThrow(AssertionError)
  })

  test('supports string and instance matchers', () => {
    expect('alpha-123').toMatch(/PHA-\d+/i)
    expect('alpha-123').toMatch('pha')
    expect('alpha-123').toStartWith('alpha')
    expect('alpha-123').toEndWith('123')
    expect(new TypeError('bad')).toBeInstanceOf(Error)

    bunExpect(() => expect('alpha').toMatch(/z/)).toThrow(AssertionError)
    bunExpect(() => expect('alpha').toStartWith('pha')).toThrow(AssertionError)
    bunExpect(() => expect('alpha').toEndWith('alp')).toThrow(AssertionError)
  })

  test('supports all toThrow expectations and preserves thrown values', () => {
    expect(() => {
      throw new TypeError('bad wolf')
    }).toThrow()
    expect(() => {
      throw new TypeError('bad wolf')
    }).toThrow('wolf')
    expect(() => {
      throw new TypeError('bad wolf')
    }).toThrow(/BAD/i)
    expect(() => {
      throw new TypeError('bad wolf')
    }).toThrow(TypeError)
    expect(() => {
      throw new TypeError('bad wolf')
    }).toThrow({ message: 'bad wolf' })
    expect(() => {
      throw 'plain rejection'
    }).toThrow('plain')

    bunExpect(() => expect(() => undefined).toThrow()).toThrow(AssertionError)
    bunExpect(() => expect(() => { throw new Error('other') }).toThrow({ message: 'bad' })).toThrow(AssertionError)
  })

  test('supports nested asymmetric matchers', () => {
    expect({
      id: 7,
      owner: 'Ada Lovelace',
      tags: ['stable', 'release-42'],
      detail: { active: true, ignored: 'extra' },
    }).toEqual(expect.objectContaining({
      id: expect.any(Number),
      owner: expect.stringContaining('Lovelace'),
      tags: expect.arrayContaining([
        expect.stringMatching(/^release-\d+$/),
        expect.anything(),
      ]),
      detail: expect.objectContaining({ active: true }),
    }))
    expect(new Number(2)).toEqual(expect.any(Number))

    bunExpect(expect.any(String).text).toContain('String')
    bunExpect(() => expect({ value: null }).toEqual({ value: expect.anything() })).toThrow(AssertionError)
    bunExpect(() => expect(['a']).toEqual(expect.arrayContaining(['a', 'b']))).toThrow(AssertionError)
  })

  test('supports negation for every synchronous matcher shape', () => {
    expect(1).not.toBe(2)
    expect({ a: 1 }).not.toEqual({ a: 2 })
    expect('abc').not.toContain('z')
    expect(() => undefined).not.toThrow()

    bunExpect(() => expect({ a: 1 }).not.toEqual({ a: 1 })).toThrow(AssertionError)
  })

  test('supports resolves and rejects, including negation and rejected toThrow', async () => {
    await expect(Promise.resolve({ id: 1 })).resolves.toEqual({ id: 1 })
    await expect(Promise.resolve(1)).resolves.not.toBe(2)
    await expect(Promise.reject({ code: 'E_FAIL' })).rejects.toMatchObject({ code: 'E_FAIL' })
    await expect(Promise.reject(new TypeError('bad wolf'))).rejects.toThrow(TypeError)
    await expect(Promise.reject(new Error('bad wolf'))).rejects.not.toThrow('cat')

    bunExpect(await caughtAsync(() => expect(Promise.reject(new Error('boom'))).resolves.toBe(1))).toBeInstanceOf(AssertionError)
    bunExpect(await caughtAsync(() => expect(Promise.resolve(1)).rejects.toBe(1))).toBeInstanceOf(AssertionError)
    bunExpect(await caughtAsync(() => expect(1 as unknown as Promise<number>).resolves.toBe(1))).toBeInstanceOf(AssertionError)
  })

  test('reports AssertionError diagnostics with custom message and both values', () => {
    const error = caught(() => expect({ actual: 1 }, 'plugin result mismatch').toEqual({ expected: 2 }))

    bunExpect(error).toBeInstanceOf(AssertionError)
    bunExpect(error.name).toBe('AssertionError')
    bunExpect(error.message).toContain('plugin result mismatch')
    bunExpect(error.message).toContain('toEqual')
    bunExpect(error.message).toContain('Expected:')
    bunExpect(error.message).toContain('expected')
    bunExpect(error.message).toContain('Received:')
    bunExpect(error.message).toContain('actual')
    bunExpect((error as AssertionError).actual).toEqual({ actual: 1 })
    bunExpect((error as AssertionError).expected).toEqual({ expected: 2 })
  })

  test('handles cyclic structures without recursion failures', () => {
    const received: { name: string; self?: unknown } = { name: 'cycle' }
    received.self = received
    const expected: { name: string; self?: unknown } = { name: 'cycle' }
    expected.self = expected

    expect(received).toEqual(expected)
    expect(received).toMatchObject({ self: expect.objectContaining({ name: 'cycle' }) })
  })
})
