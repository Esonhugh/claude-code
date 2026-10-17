function receipt(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJSON(value: unknown): string | undefined {
  const copies = new WeakMap<object, Record<string, unknown>>()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (!receipt(item)) return item
      const prior = copies.get(item)
      if (prior) return prior
      const sorted = Object.create(null) as Record<string, unknown>
      copies.set(item, sorted)
      for (const key of Object.keys(item).sort())
        Object.defineProperty(sorted, key, { value: item[key], enumerable: true })
      return sorted
    })
  } catch {
    // Unserializable values cannot prove equality across the plugin boundary.
    return undefined
  }
}

/** Core owns this fact; a plugin can retain it only through its downstream next ref. */
export function restoreToolCallReadOnly(value: unknown, below: readonly unknown[]): unknown {
  if (!receipt(value)) return value
  const { isReadOnly: _claimed, ...result } = value
  if (result.deny !== undefined || result.ref === undefined) return result
  const original = below.findLast(item => receipt(item) && item.ref === result.ref)
  if (!receipt(original) || original.isReadOnly !== true) return result
  const serialized = canonicalJSON(result.result)
  return result.result === undefined || result.result === original.result ||
    (serialized !== undefined && serialized === canonicalJSON(original.result))
    ? { ...result, isReadOnly: true }
    : result
}
