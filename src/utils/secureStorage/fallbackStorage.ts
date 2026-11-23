import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Creates a fallback storage that tries to use the primary storage first,
 * and if that fails, falls back to the secondary storage
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,
    // @ts-ignore - recovered code
    read(): SecureStorageData {
      // @ts-ignore - recovered code
      const result = primary.read()
      if (result !== null && result !== undefined) {
        // @ts-ignore - recovered code
        return result
      }
      // @ts-ignore - recovered code
      return secondary.read() || {}
    },
    // @ts-ignore - recovered code
    async readAsync(): Promise<SecureStorageData | null> {
      // @ts-ignore - recovered code
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        // @ts-ignore - recovered code
        return result
      }
      // @ts-ignore - recovered code
      return (await secondary.readAsync()) || {}
    },
    // @ts-ignore - recovered code
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Capture state before update
      // @ts-ignore - recovered code
      const primaryDataBefore = primary.read()

      // @ts-ignore - recovered code
      const result = primary.update(data)

      // @ts-ignore - recovered code
      if (result.success) {
        // Delete secondary when migrating to primary for the first time
        // This preserves credentials when sharing .claude between host and containers
        // See: https://github.com/anthropics/claude-code/issues/1414
        if (primaryDataBefore === null) {
          // @ts-ignore - recovered code
          secondary.delete()
        }
        // @ts-ignore - recovered code
        return result
      }

      // @ts-ignore - recovered code
      const fallbackResult = secondary.update(data)

      // @ts-ignore - recovered code
      if (fallbackResult.success) {
        // Primary write failed but primary may still hold an *older* valid
        // entry. read() prefers primary whenever it returns non-null, so that
        // stale entry would shadow the fresh data we just wrote to secondary —
        // e.g. a refresh token the server has already rotated away, causing a
        // /login loop (#30337). If the stale entry cannot be removed either,
        // the write is not visible to readers and must not count as saved.
        // @ts-ignore - recovered code
        if (primaryDataBefore !== null && !primary.delete()) {
          return { success: false }
        }
        return {
          success: true,
          // @ts-ignore - recovered code
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    // @ts-ignore - recovered code
    delete(): boolean {
      // @ts-ignore - recovered code
      const primarySuccess = primary.delete()
      // @ts-ignore - recovered code
      const secondarySuccess = secondary.delete()

      // @ts-ignore - recovered code
      return primarySuccess || secondarySuccess
    },
    // Proves the next update() will be visible to every reader, before a
    // caller spends something it cannot get back (a refresh token the server
    // rotates on use). When primary holds data but takes no write, the data
    // moves to secondary only if primary's entry can be removed; otherwise it
    // would shadow secondary and readers would keep the old data.
    async proveWrites(): Promise<{ success: boolean }> {
      // @ts-ignore - recovered code
      const current = primary.read()
      if (current === null || current === undefined) {
        return { success: true }
      }
      if (typeof primary.probeWrite !== 'function') {
        return { success: true }
      }
      // @ts-ignore - recovered code
      if ((await primary.probeWrite()).success) {
        return { success: true }
      }
      // @ts-ignore - recovered code
      if (primary.update(current).success) {
        return { success: true }
      }
      if (writeProofTried) {
        return { success: false }
      }
      // @ts-ignore - recovered code
      const secondaryBefore = secondary.read()
      // @ts-ignore - recovered code
      if (!secondary.update(current).success) {
        return { success: false }
      }
      // @ts-ignore - recovered code
      if (primary.delete()) {
        return { success: true }
      }
      writeProofTried = true
      if (secondaryBefore) {
        // @ts-ignore - recovered code
        secondary.update(secondaryBefore)
      } else {
        // @ts-ignore - recovered code
        secondary.delete()
      }
      return { success: false }
    },
  }
}

// Moving the data to secondary is tried once per process.
let writeProofTried = false

export function _resetWriteProofForTesting(): void {
  writeProofTried = false
}
