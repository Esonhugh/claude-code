import { isDeepStrictEqual } from 'node:util'
import type { ModInput, ModOrigin } from './types.js'
import type { ModDispatchOptions } from './runtime.js'

export type ModConfigValue = boolean | string | number | readonly string[]
export type ModConfigOrigin =
  | { kind: 'composer' | 'bridge' }
  | { kind: 'plugin'; name: string }
export type ModConfigRow = {
  key: string
  label: string
  description?: string
  kind: 'boolean' | 'choice' | 'text' | 'number'
  value: ModConfigValue
  options?: readonly string[]
  provider: ModOrigin
  isLocked: boolean
}
export type ModConfigRowProvider = ModConfigRow & {
  isHidden?: boolean
  set?(value: ModConfigValue): void | Promise<void>
  validate?(value: ModConfigValue): string | undefined
}
export type ModConfigSetResult =
  | { value: ModConfigValue; deny?: undefined }
  | { deny: string; value?: undefined }
type Description = Pick<ModConfigRow, 'label' | 'description'> & {
  isHidden: boolean
}
type Dispatch = (
  event: string,
  input: ModInput,
  core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>,
  options?: ModDispatchOptions,
) => Promise<unknown>

function fits(row: ModConfigRow, value: unknown): value is ModConfigValue {
  if (row.kind === 'boolean') return typeof value === 'boolean'
  if (row.kind === 'number')
    return typeof value === 'number' && Number.isFinite(value)
  if (row.kind === 'choice')
    return typeof value === 'string' && Boolean(row.options?.includes(value))
  return Array.isArray(row.value)
    ? Array.isArray(value) && value.every(item => typeof item === 'string')
    : typeof value === 'string'
}

export function createModConfig(
  rows: () =>
    | readonly ModConfigRowProvider[]
    | Promise<readonly ModConfigRowProvider[]>,
  dispatch: Dispatch,
  getGeneration?: () => object,
) {
  const localGeneration = {}
  let descriptions = new WeakMap<
    object,
    Map<string, { input: ModInput; result: Promise<Description> }>
  >()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh() {
      changed()
    },
    invalidate() {
      descriptions = new WeakMap()
      changed()
    },
    async list(
      run = dispatch,
      generation = getGeneration?.() ?? localGeneration,
    ): Promise<ModConfigRow[]> {
      const result: ModConfigRow[] = []
      let cache = descriptions.get(generation)
      if (!cache) {
        cache = new Map()
        descriptions.set(generation, cache)
      }
      for (const row of await rows()) {
        const input = {
          key: row.key,
          label: row.label,
          description: row.description,
          isHidden: row.isHidden ?? false,
          provider: row.provider,
        }
        let entry = cache.get(row.key)
        if (!entry || !isDeepStrictEqual(entry.input, input)) {
          const validateDescription = (value: unknown) => {
            const item = value as Description | null
            if (
              !item ||
              typeof item.label !== 'string' ||
              typeof item.isHidden !== 'boolean' ||
              (item.description !== undefined &&
                typeof item.description !== 'string')
            )
              throw new TypeError(
                'config.describe requires label, description and isHidden',
              )
          }
          const answer = run(
            'config.describe',
            input,
            async event => ({
              label: event.label,
              description: event.description,
              isHidden: event.isHidden,
            }),
            {
              validateInput(value) {
                for (const key of ['key', 'provider'] as const) {
                  if (!isDeepStrictEqual(value[key], input[key]))
                    throw new Error(`config.describe cannot rewrite ${key}`)
                }
                validateDescription(value)
              },
              validateResult: validateDescription,
            },
          ) as Promise<Description>
          entry = { input, result: answer }
          cache.set(row.key, entry)
          void answer.catch(() => {
            if (cache.get(row.key)?.result === answer) cache.delete(row.key)
          })
        }
        const described = await entry.result
        if (described.isHidden) continue
        result.push({
          key: row.key,
          label: described.label,
          kind: row.kind,
          value: row.value,
          provider: row.provider,
          isLocked: row.isLocked,
          ...(described.description === undefined
            ? {}
            : { description: described.description }),
          ...(row.options === undefined ? {} : { options: row.options }),
        })
      }
      return result
    },
    async set(
      args: { key: string; value: ModConfigValue },
      origin: ModConfigOrigin,
      run = dispatch,
      dialogWriter?: ModConfigRowProvider['set'],
    ): Promise<ModConfigSetResult> {
      if (!args || typeof args !== 'object' || typeof args.key !== 'string')
        throw new TypeError('config.set takes { key, value }')
      const row = (await rows()).find(item => item.key === args.key)
      if (!row) throw new Error(`Unknown config key: ${args.key}`)
      const input = {
        key: row.key,
        value: args.value,
        previous: row.value,
        provider: row.provider,
        origin,
      }
      return (await run(
        'config.set',
        input,
        async (event, signal) => {
          // Re-read ownership at the write boundary, not when the menu opened.
          const current = (await rows()).find(item => item.key === row.key)
          signal?.throwIfAborted()
          if (!current) throw new Error(`Unknown config key: ${row.key}`)
          if (current.isLocked)
            return { deny: 'This setting is locked by a trusted source' }
          const writer = current.set ?? dialogWriter
          if (!writer)
            return { deny: 'This setting can only be changed in its dialog' }
          if (!fits(current, event.value))
            return { deny: `Invalid value for ${row.key} (${current.kind})` }
          const error = current.validate?.(event.value)
          if (error) return { deny: error }
          await writer(event.value)
          changed()
          return { value: event.value }
        },
        {
          validateInput(value) {
            for (const key of [
              'key',
              'previous',
              'provider',
              'origin',
            ] as const) {
              if (!isDeepStrictEqual(value[key], input[key]))
                throw new Error(`config.set cannot rewrite ${key}`)
            }
          },
          validateResult(value) {
            const item = value as ModConfigSetResult | null
            if (!item || typeof item !== 'object' || Array.isArray(item))
              throw new TypeError('config.set requires a row value or deny')
            if (
              item.deny !== undefined
                ? typeof item.deny !== 'string' || item.value !== undefined
                : !fits(row, item.value)
            )
              throw new TypeError('config.set requires a row value or deny')
          },
        },
      )) as ModConfigSetResult
    },
  }
}
