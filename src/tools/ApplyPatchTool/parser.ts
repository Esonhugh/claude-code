// Codex apply_patch format: a patch is a list of file operations between
// `*** Begin Patch` and `*** End Patch`. Updates are hunks of context (' '),
// removed ('-') and added ('+') lines, each optionally introduced by
// `@@ <line to seek first>`.

export type PatchChunk = {
  changeContext: string | null
  oldLines: string[]
  newLines: string[]
  isEndOfFile: boolean
}

export type PatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath: string | null; chunks: PatchChunk[] }

export class PatchParseError extends Error {}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '
const MOVE = '*** Move to: '
const EOF_MARKER = '*** End of File'

function isFileHeader(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE) || line.trim() === END
}

function stripHeredoc(lines: string[]): string[] {
  // Models sometimes send the shell form: apply_patch <<'EOF' ... EOF
  if (lines.length >= 2 && /^(apply_patch\s+)?<<['"]?\w+['"]?\s*$/.test(lines[0]!.trim())) {
    const last = lines[lines.length - 1]!.trim()
    if (/^\w+$/.test(last)) return lines.slice(1, -1)
  }
  return lines
}

export function parsePatch(text: string): PatchOperation[] {
  let lines = text.replace(/\r\n/g, '\n').trim().split('\n')
  lines = stripHeredoc(lines)
  if (lines[0]?.trim() !== BEGIN) {
    throw new PatchParseError(`The first line of the patch must be '${BEGIN}'`)
  }
  if (lines[lines.length - 1]?.trim() !== END) {
    throw new PatchParseError(`The last line of the patch must be '${END}'`)
  }

  const ops: PatchOperation[] = []
  let i = 1
  const end = lines.length - 1
  while (i < end) {
    const line = lines[i]!
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim()
      i++
      const content: string[] = []
      while (i < end && !isFileHeader(lines[i]!)) {
        const l = lines[i]!
        if (!l.startsWith('+')) {
          throw new PatchParseError(`Invalid line in Add File ${path}: '${l}'. Every line of a new file must start with '+'.`)
        }
        content.push(l.slice(1))
        i++
      }
      ops.push({ type: 'add', path, content: content.length ? content.join('\n') + '\n' : '' })
    } else if (line.startsWith(DELETE)) {
      ops.push({ type: 'delete', path: line.slice(DELETE.length).trim() })
      i++
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim()
      i++
      let movePath: string | null = null
      if (i < end && lines[i]!.startsWith(MOVE)) {
        movePath = lines[i]!.slice(MOVE.length).trim()
        i++
      }
      const chunks: PatchChunk[] = []
      while (i < end && !isFileHeader(lines[i]!)) {
        const header = lines[i]!
        let changeContext: string | null = null
        if (header.trim() === '@@') {
          i++
        } else if (header.startsWith('@@ ')) {
          changeContext = header.slice(3)
          i++
        } else if (chunks.length > 0) {
          throw new PatchParseError(`Expected '@@' to start a new hunk in ${path}, got: '${header}'`)
        }
        const chunk: PatchChunk = { changeContext, oldLines: [], newLines: [], isEndOfFile: false }
        while (i < end && !isFileHeader(lines[i]!) && !lines[i]!.startsWith('@@')) {
          const l = lines[i]!
          if (l.trim() === EOF_MARKER) {
            chunk.isEndOfFile = true
            i++
            break
          }
          const marker = l[0]
          const body = l.slice(1)
          if (l === '' || marker === ' ') {
            chunk.oldLines.push(l === '' ? '' : body)
            chunk.newLines.push(l === '' ? '' : body)
          } else if (marker === '-') {
            chunk.oldLines.push(body)
          } else if (marker === '+') {
            chunk.newLines.push(body)
          } else {
            throw new PatchParseError(`Invalid hunk line in ${path}: '${l}'. Hunk lines start with ' ', '-' or '+'.`)
          }
          i++
        }
        if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
          throw new PatchParseError(`Empty hunk in ${path}`)
        }
        chunks.push(chunk)
      }
      if (chunks.length === 0 && movePath === null) {
        throw new PatchParseError(`Update File ${path} has no hunks`)
      }
      ops.push({ type: 'update', path, movePath, chunks })
    } else if (line.trim() === '') {
      i++
    } else {
      throw new PatchParseError(`'${line}' is not a valid file header. Use '${ADD}', '${DELETE}' or '${UPDATE}'.`)
    }
  }
  if (ops.length === 0) throw new PatchParseError('The patch contains no file operations')
  return ops
}

const normalizers: Array<(s: string) => string> = [
  s => s,
  s => s.trimEnd(),
  s => s.trim(),
  s =>
    s
      .trim()
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' '),
]

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return -1
  const from = eof ? lines.length - pattern.length : start
  for (const norm of normalizers) {
    for (let i = Math.max(from, 0); i <= lines.length - pattern.length; i++) {
      let ok = true
      for (let j = 0; j < pattern.length; j++) {
        if (norm(lines[i + j]!) !== norm(pattern[j]!)) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
  }
  // An EOF hunk that does not sit at the very end may still match later in the file.
  return eof ? seekSequence(lines, pattern, start, false) : -1
}

/** Applies update hunks to `content` (LF line endings). Throws PatchParseError when a hunk does not match. */
export function applyChunks(content: string, chunks: PatchChunk[], path: string): string {
  const lines = content.split('\n')
  // A trailing newline leaves an empty last element; hunks never address it.
  if (lines[lines.length - 1] === '') lines.pop()

  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const idx = seekSequence(lines, [chunk.changeContext], lineIndex, false)
      if (idx < 0) {
        throw new PatchParseError(`Failed to find context '${chunk.changeContext}' in ${path}`)
      }
      lineIndex = idx + 1
    }
    if (chunk.oldLines.length === 0) {
      // Pure insertion: at the end of file, or right after the @@ context line.
      const at = chunk.changeContext === null || chunk.isEndOfFile ? lines.length : lineIndex
      replacements.push([at, 0, chunk.newLines])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let found = seekSequence(lines, oldLines, lineIndex, chunk.isEndOfFile)
    if (found < 0 && oldLines[oldLines.length - 1] === '') {
      // A trailing blank context line often stands for the final newline.
      oldLines = oldLines.slice(0, -1)
      if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1)
      found = seekSequence(lines, oldLines, lineIndex, chunk.isEndOfFile)
    }
    if (found < 0) {
      throw new PatchParseError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}\nRead the file again and resend the patch with lines that match it exactly.`,
      )
    }
    replacements.push([found, oldLines.length, newLines])
    lineIndex = found + oldLines.length
  }

  replacements.sort((a, b) => a[0] - b[0])
  for (let k = replacements.length - 1; k >= 0; k--) {
    const [start, count, insert] = replacements[k]!
    lines.splice(start, count, ...insert)
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}
