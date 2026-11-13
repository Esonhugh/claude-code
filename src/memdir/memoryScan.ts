/**
 * Memory-directory scanning primitives. Split out of findRelevantMemories.ts
 * so extractMemories can import the scan without pulling in sideQuery and
 * the API-client chain (which closed a cycle through memdir.ts — #25372).
 */

import type { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'
import { neutralizeMemoryContent } from './neutralizeMemoryContent.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200

/**
 * Paths of the files under `dir`, relative to it, like readdir's recursive
 * option but without entering symlinked directories: Bun's recursive readdir
 * follows them, so a link back into the directory fails with ELOOP or, with
 * two such links, grows until the process runs out of memory. A subdirectory
 * that cannot be read is skipped; an unreadable `dir` throws.
 */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (relative: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(join(dir, relative), { withFileTypes: true })
    } catch (e) {
      if (relative === '') throw e
      return
    }
    for (const entry of entries) {
      const path = relative ? join(relative, entry.name) : entry.name
      if (entry.isDirectory()) await walk(path)
      else files.push(path)
    }
  }
  await walk('')
  return files
}
const FRONTMATTER_MAX_LINES = 30

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at `limit`, default MAX_MEMORY_FILES). Shared by
 * findRelevantMemories (query-time recall) and extractMemories (pre-injects
 * the listing so the extraction agent doesn't spend a turn on `ls`).
 *
 * Single-pass: readFileInRange stats internally and returns mtimeMs, so we
 * read-then-sort rather than stat-sort-read. For the common case (N ≤ 200)
 * this halves syscalls vs a separate stat round; for large N we read a few
 * extra small files but still avoid the double-stat on the surviving 200.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
  limit = MAX_MEMORY_FILES,
): Promise<MemoryHeader[]> {
  try {
    const entries = await listFilesRecursive(memoryDir)
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        const metadata = frontmatter.metadata
        const fields = {
          type: frontmatter.type,
          ...(typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
            ? metadata
            : {}),
        }
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(fields.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
  } catch {
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description. Used by both the recall
 * selector prompt and the extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${neutralizeMemoryContent(m.description)}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
