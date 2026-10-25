import { buildMemoryIndex } from '../../memdir/memoryIndex.js'
import { getSqliteMemoryScopes } from '../../memdir/paths.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatFileSize } from '../../utils/format.js'

/** Shared by /setup-memory-db and the /memory "Build memory index" row. */
export async function buildMemoryIndexSummary(): Promise<string> {
  const scopes = getSqliteMemoryScopes()
  const status = await buildMemoryIndex(scopes)
  return `Memory index built (${scopes.join(', ')}): ${status.files} files, ${status.chunks} entries, ${formatFileSize(status.bytes)} at ${getDisplayPath(status.path)}`
}

export async function call(): Promise<LocalCommandResult> {
  try {
    return { type: 'text', value: await buildMemoryIndexSummary() }
  } catch (error) {
    return { type: 'text', value: `Failed to build memory index: ${error}` }
  }
}
