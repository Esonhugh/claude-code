import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { isENOENT } from '../../utils/errors.js'
import { type LineEndingType, notTextMessage, readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { expandPath } from '../../utils/path.js'
import { applyChunks, PatchParseError, parsePatch, type PatchOperation } from './parser.js'
import { APPLY_PATCH_TOOL_NAME } from './prompt.js'

// Kept apart from ApplyPatchTool.ts so hooks.ts can use it without importing
// the tool and everything the tool imports.

export type PlannedFile = {
  op: PatchOperation
  absolutePath: string
  absoluteMovePath: string | null
  original: string
  updated: string | null
  encoding: BufferEncoding
  lineEndings: LineEndingType
}

function readExisting(absolutePath: string): ReturnType<typeof readFileSyncWithMetadata> | null {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    return readFileSyncWithMetadata(absolutePath)
  } catch (e) {
    if (isENOENT(e)) return null
    throw e
  }
}

/**
 * Resolves every operation against the files on disk without writing. Throws
 * PatchParseError with a message for the model when any part does not apply,
 * so a patch is applied whole or not at all.
 */
export function planPatch(patch: string): PlannedFile[] {
  const ops = parsePatch(patch)
  const planned: PlannedFile[] = []
  const seen = new Set<string>()
  for (const op of ops) {
    const absolutePath = expandPath(op.path)
    const absoluteMovePath = op.type === 'update' && op.movePath ? expandPath(op.movePath) : null
    for (const p of [absolutePath, absoluteMovePath]) {
      if (p === null) continue
      // SECURITY: no filesystem access for UNC paths (NTLM credential leak on Windows).
      if (p.startsWith('\\\\') || p.startsWith('//')) {
        throw new PatchParseError(`${p}: network paths are not supported by ${APPLY_PATCH_TOOL_NAME}.`)
      }
      if (seen.has(p)) throw new PatchParseError(`${p} appears more than once in the patch. Combine its changes into one section.`)
      seen.add(p)
    }
    const existing = readExisting(absolutePath)
    if (existing?.notText) throw new PatchParseError(`${op.path}: ${notTextMessage(existing.notText)}`)
    if (op.type === 'add') {
      if (existing) throw new PatchParseError(`${op.path} already exists. Use '*** Update File' to change it.`)
      planned.push({ op, absolutePath, absoluteMovePath, original: '', updated: op.content, encoding: 'utf8', lineEndings: 'LF' })
      continue
    }
    if (!existing) throw new PatchParseError(`${op.path} does not exist.`)
    if (op.type === 'delete') {
      planned.push({ op, absolutePath, absoluteMovePath, original: existing.content, updated: null, encoding: existing.encoding, lineEndings: existing.lineEndings })
      continue
    }
    if (absoluteMovePath && readExisting(absoluteMovePath)) {
      throw new PatchParseError(`Cannot move ${op.path} to ${op.movePath}: the destination already exists.`)
    }
    const updated = op.chunks.length ? applyChunks(existing.content, op.chunks, op.path) : existing.content
    planned.push({ op, absolutePath, absoluteMovePath, original: existing.content, updated, encoding: existing.encoding, lineEndings: existing.lineEndings })
  }
  return planned
}

export function touchedPaths(patch: string): string[] {
  const ops = parsePatch(patch)
  return ops.flatMap(op => [op.path, ...(op.type === 'update' && op.movePath ? [op.movePath] : [])]).map(p => expandPath(p))
}

export type PatchHookStep = {
  toolName: typeof FILE_EDIT_TOOL_NAME | typeof FILE_WRITE_TOOL_NAME
  input: Record<string, unknown>
  response: Record<string, unknown>
}

/**
 * The patch as the Edit and Write calls that would make the same change, one
 * per file: a new file is a Write, a changed file an Edit of its whole
 * content, a deleted file an Edit to empty, and a move a Write of the new
 * path plus a deleting Edit of the old one. `updated` null means deleted.
 */
export function patchHookSteps(
  files: { path: string; movePath: string | null; original: string | null; updated: string | null }[],
): PatchHookStep[] {
  const edit = (path: string, original: string, updated: string): PatchHookStep => ({
    toolName: FILE_EDIT_TOOL_NAME,
    input: { file_path: path, old_string: original, new_string: updated, replace_all: false },
    response: { filePath: path, oldString: original, newString: updated, originalFile: original, userModified: false, replaceAll: false },
  })
  const write = (path: string, content: string): PatchHookStep => ({
    toolName: FILE_WRITE_TOOL_NAME,
    input: { file_path: path, content },
    response: { type: 'create', filePath: path, content, originalFile: null },
  })
  return files.flatMap(({ path, movePath, original, updated }) => {
    if (original === null) return updated === null ? [] : [write(path, updated)]
    if (updated === null) return [edit(path, original, '')]
    return movePath ? [write(movePath, updated), edit(path, original, '')] : [edit(path, original, updated)]
  })
}

/** Steps for a patch not yet applied; none when it does not apply. */
export function plannedPatchHookSteps(patch: string): PatchHookStep[] {
  let planned: PlannedFile[]
  try {
    planned = planPatch(patch)
  } catch {
    return []
  }
  return patchHookSteps(
    planned.map(f => ({
      path: f.absolutePath,
      movePath: f.absoluteMovePath,
      original: f.op.type === 'add' ? null : f.original,
      updated: f.updated,
    })),
  )
}

/** Steps for an applied patch, read from the tool's result and the disk. */
export function appliedPatchHookSteps(output: unknown): PatchHookStep[] {
  const files = (output as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) return []
  return patchHookSteps(
    files.map((f: { type: string; filePath: string; movePath?: string; originalFile: string }) => {
      const path = expandPath(f.filePath)
      const movePath = f.movePath ? expandPath(f.movePath) : null
      return {
        path,
        movePath,
        original: f.type === 'add' ? null : f.originalFile,
        updated: f.type === 'delete' ? null : (readExisting(movePath ?? path)?.content ?? null),
      }
    }),
  )
}
