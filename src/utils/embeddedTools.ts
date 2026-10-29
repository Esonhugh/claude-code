import path from 'node:path'
import { getSearchToolsOptIn } from '../bootstrap/state.js'
import { CACHE_PATHS } from './cachePaths.js'
import { extractEmbeddedBinary } from './embeddedRipgrep.js'
import { isEnvDefinedFalsy } from './envUtils.js'

/**
 * Whether this binary embeds bfs/ugrep (Linux and macOS release builds set
 * CLAUDE_CODE_EMBEDDED_{BFS,UGREP}_PATH in the packaged entrypoint).
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that run the extracted bfs / ugrep
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 *
 * Like official 2.1.311, naming Glob or Grep in --tools / --allowedTools keeps
 * the dedicated tools. EMBEDDED_SEARCH_TOOLS=0 turns this off.
 */
export function hasEmbeddedSearchTools(): boolean {
  if (isEnvDefinedFalsy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  if (
    !process.env.CLAUDE_CODE_EMBEDDED_BFS_PATH ||
    !process.env.CLAUDE_CODE_EMBEDDED_UGREP_PATH ||
    !process.env.CLAUDE_CODE_EMBEDDED_SEARCH_TOOLS_VERSION
  ) {
    return false
  }
  if (getSearchToolsOptIn()) return false
  return process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
}

/**
 * Extracts the embedded bfs and ugrep so the shell can run them. Only
 * meaningful when hasEmbeddedSearchTools() is true.
 */
export function embeddedSearchToolPaths(): { bfs: string; ugrep: string } {
  const directory = path.join(
    CACHE_PATHS.searchTools(),
    `${process.env.CLAUDE_CODE_EMBEDDED_SEARCH_TOOLS_VERSION}-${process.arch}-${process.platform}`,
  )
  return {
    bfs: extractEmbeddedBinary(
      process.env.CLAUDE_CODE_EMBEDDED_BFS_PATH!,
      path.join(directory, 'bfs'),
    ),
    ugrep: extractEmbeddedBinary(
      process.env.CLAUDE_CODE_EMBEDDED_UGREP_PATH!,
      path.join(directory, 'ugrep'),
    ),
  }
}
