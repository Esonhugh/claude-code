// The red/green rows of an Edit, Write, MultiEdit or NotebookEdit card: the
// tool's own structured patch when the result carries one, else a diff of
// the tool input.

import { structuredPatch } from 'diff'

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }

export type ToolDiff = { rows: DiffRow[]; added: number; removed: number; created: boolean }

type Hunk = { oldStart: number; newStart: number; oldLines: number; newLines: number; lines: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

function isHunk(v: unknown): v is Hunk {
  return isObj(v) && typeof v.oldStart === 'number' && typeof v.newStart === 'number' && Array.isArray(v.lines)
}

/** Rows of unified diff hunks, numbered from each hunk's start. */
export function hunkRows(hunks: Hunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  for (const h of hunks) {
    rows.push({ kind: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` })
    let o = h.oldStart
    let n = h.newStart
    for (const line of h.lines) {
      if (line.startsWith('\\')) continue
      const mark = line[0]
      const text = line.slice(1)
      if (mark === '+') rows.push({ kind: 'add', new: n++, text })
      else if (mark === '-') rows.push({ kind: 'del', old: o++, text })
      else rows.push({ kind: 'ctx', old: o++, new: n++, text })
    }
  }
  return rows
}

function withCounts(rows: DiffRow[], created: boolean): ToolDiff {
  return {
    rows,
    added: rows.filter(r => r.kind === 'add').length,
    removed: rows.filter(r => r.kind === 'del').length,
    created,
  }
}

function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const editHunks = (oldText: string, newText: string): Hunk[] =>
  structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 }).hunks

/**
 * The diff a file tool shows, or undefined when the tool is not a file edit
 * or its input is not complete JSON yet. `result` is the tool's
 * `tool_use_result`; its `structuredPatch` has the real line numbers.
 */
export function toolDiff(name: string, input: string, result?: unknown): ToolDiff | undefined {
  if (!['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return undefined
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(input)
    if (!isObj(parsed)) return undefined
    args = parsed
  } catch {
    return undefined
  }
  const patch = isObj(result) && Array.isArray(result.structuredPatch) ? result.structuredPatch.filter(isHunk) : []
  const created = isObj(result) ? result.type === 'create' : name === 'Write'
  if (patch.length) return withCounts(hunkRows(patch), created)
  if (name === 'Write') {
    const content = str(args.content)
    if (content === undefined) return undefined
    if (!created) return undefined
    return withCounts(
      linesOf(content).map((text, i) => ({ kind: 'add', new: i + 1, text })),
      true,
    )
  }
  if (name === 'NotebookEdit') {
    const source = str(args.new_source)
    if (source === undefined) return undefined
    return withCounts(
      linesOf(source).map((text, i) => ({ kind: 'add', new: i + 1, text })),
      false,
    )
  }
  const edits =
    name === 'MultiEdit' ? (Array.isArray(args.edits) ? args.edits.filter(isObj) : []) : [args]
  const hunks = edits.flatMap(e => {
    const oldText = str(e.old_string)
    const newText = str(e.new_string)
    return oldText === undefined || newText === undefined ? [] : editHunks(oldText, newText)
  })
  return hunks.length ? withCounts(hunkRows(hunks), false) : undefined
}
