import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { getErrnoCode, isENOENT } from '../../utils/errors.js'
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
    const code = getErrnoCode(e)
    if (code === 'EISDIR') throw new PatchParseError(`${absolutePath} is a directory, not a file.`)
    if (code === 'ENOTDIR') throw new PatchParseError(`${absolutePath}: a parent path is a file, not a directory.`)
    throw e
  }
}

export type PatchPlan = {
  planned: PlannedFile[]
  /** The first file that does not apply; files after it are not attempted. */
  failure: { path: string; message: string } | null
}

/**
 * Resolves the operations in order against the files on disk without writing.
 * A malformed patch throws PatchParseError. Like Codex, a file that does not
 * apply stops the plan there: the files before it are kept in `planned`.
 */
export function planPatch(patch: string): PatchPlan {
  const ops = parsePatch(patch)
  const seen = new Set<string>()
  for (const op of ops) {
    for (const p of [op.path, ...(op.type === 'update' && op.movePath ? [op.movePath] : [])].map(p => expandPath(p))) {
      // SECURITY: no filesystem access for UNC paths (NTLM credential leak on Windows).
      if (p.startsWith('\\\\') || p.startsWith('//')) {
        throw new PatchParseError(`${p}: network paths are not supported by ${APPLY_PATCH_TOOL_NAME}.`)
      }
      if (seen.has(p)) throw new PatchParseError(`${p} appears more than once in the patch. Combine its changes into one section.`)
      seen.add(p)
    }
  }
  const planned: PlannedFile[] = []
  for (const op of ops) {
    try {
      planned.push(planFile(op))
    } catch (e) {
      if (!(e instanceof PatchParseError)) throw e
      return { planned, failure: { path: op.path, message: e.message } }
    }
  }
  return { planned, failure: null }
}

function planFile(op: PatchOperation): PlannedFile {
  const absolutePath = expandPath(op.path)
  const absoluteMovePath = op.type === 'update' && op.movePath ? expandPath(op.movePath) : null
  const existing = readExisting(absolutePath)
  if (existing?.notText) throw new PatchParseError(`${op.path}: ${notTextMessage(existing.notText)}`)
  if (op.type === 'add') {
    if (existing) throw new PatchParseError(`${op.path} already exists. Use '*** Update File' to change it.`)
    return { op, absolutePath, absoluteMovePath, original: '', updated: op.content, encoding: 'utf8', lineEndings: 'LF' }
  }
  if (!existing) throw new PatchParseError(`${op.path} does not exist.`)
  const base = { op, absolutePath, absoluteMovePath, original: existing.content, encoding: existing.encoding, lineEndings: existing.lineEndings }
  if (op.type === 'delete') return { ...base, updated: null }
  if (absoluteMovePath && readExisting(absoluteMovePath)) {
    throw new PatchParseError(`Cannot move ${op.path} to ${op.movePath}: the destination already exists.`)
  }
  // Hunks address lines without the byte order mark; keep it on the first line.
  const bom = existing.content.startsWith('\uFEFF') ? '\uFEFF' : ''
  return {
    ...base,
    updated: op.chunks.length ? bom + applyChunks(existing.content.slice(bom.length), op.chunks, op.path) : existing.content,
  }
}

export function touchedPaths(patch: string): string[] {
  const ops = parsePatch(patch)
  return ops.flatMap(op => [op.path, ...(op.type === 'update' && op.movePath ? [op.movePath] : [])]).map(p => expandPath(p))
}

/** The absolute paths an apply_patch tool input writes; none when it is not a valid patch. */
export function applyPatchInputPaths(input: unknown): string[] {
  const patch = (input as { input?: unknown } | null)?.input
  if (typeof patch !== 'string') return []
  try {
    return touchedPaths(patch)
  } catch {
    return []
  }
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

/** Steps for the files of a patch that would apply; none when it is malformed. */
export function plannedPatchHookSteps(patch: string): PatchHookStep[] {
  let planned: PlannedFile[]
  try {
    planned = planPatch(patch).planned
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
