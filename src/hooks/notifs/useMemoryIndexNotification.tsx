import { getMemoryIndexStatus } from '../../memdir/memoryIndex.js'
import { isSqliteMemoryEnabled } from '../../memdir/paths.js'
import { useStartupNotification } from './useStartupNotification.js'

export function useMemoryIndexNotification(): void {
  useStartupNotification(() => {
    if (!isSqliteMemoryEnabled() || getMemoryIndexStatus().built) return null
    return {
      timeoutMs: 15000,
      key: 'memory-index-not-built',
      text: 'Memory search index is not built yet. Run /setup-memory-db (or /memory) to build it.',
      color: 'warning',
      priority: 'low',
    }
  })
}
