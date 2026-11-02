import type { Item } from './protocol'

export type PreviewKind =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'xlsx'
  | 'docx'
  | 'office'
  | 'text'
  | 'binary'

const KINDS: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'svg',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  csv: 'csv',
  tsv: 'csv',
  xlsx: 'xlsx',
  docx: 'docx',
  pptx: 'office',
  ppt: 'office',
  odp: 'office',
  doc: 'office',
  rtf: 'office',
  odt: 'office',
  xls: 'office',
  ods: 'office',
  zip: 'binary',
  gz: 'binary',
  tar: 'binary',
  exe: 'binary',
  bin: 'binary',
  mp3: 'binary',
  mp4: 'binary',
  mov: 'binary',
  wav: 'binary',
  woff: 'binary',
  woff2: 'binary',
  ttf: 'binary',
}

export function extension(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

/** Everything without a known binary extension is tried as text. */
export function previewKind(path: string): PreviewKind {
  return KINDS[extension(path)] ?? 'text'
}

export function filesBase(sessionId: string): string {
  return `/api/files/${encodeURIComponent(sessionId)}`
}

export function fileUrl(
  sessionId: string,
  path: string,
  opts: { download?: boolean; pdf?: boolean } = {},
): string {
  return `${filesBase(sessionId)}${opts.pdf ? '/pdf' : ''}?path=${encodeURIComponent(path)}${opts.download ? '&download=1' : ''}`
}

export type Uploaded = { path: string; name: string; size: number }

export async function uploadFile(sessionId: string, file: File): Promise<Uploaded> {
  const res = await fetch(`${filesBase(sessionId)}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`${file.name}: ${body.error ?? res.statusText}`)
  }
  return (await res.json()) as Uploaded
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** RFC 4180 rows (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string, delimiter = ',', maxRows = 500): {
  rows: string[][]
  truncated: boolean
} {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
      continue
    }
    if (c === '"' && field === '') {
      quoted = true
    } else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 }
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return { rows, truncated: false }
}

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** The CLI's quoted `@"path"` mention form (JSON string escapes). */
export function mentionPath(path: string): string {
  return `@"${JSON.stringify(path).slice(1, -1)}"`
}

export type TextSegment = { text: string } | { path: string }

/** Splits user text into plain runs and absolute-path `@` mentions. */
export function splitMentions(text: string): TextSegment[] {
  const out: TextSegment[] = []
  const re = /(^|\s)@(?:"((?:[^"\\]|\\.)*)"|((?:\/|[A-Za-z]:[\\/])\S*))/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1]!.length
    let path = m[3]
    if (m[2] !== undefined) {
      try {
        path = JSON.parse(`"${m[2]}"`) as string
      } catch {
        path = m[2]
      }
    }
    if (!path || !/^(\/|[A-Za-z]:[\\/])/.test(path)) continue
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ path })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export type SessionFile = { path: string; source: 'upload' | 'read' | 'edited' | 'written' }

const TOOL_SOURCE: Record<string, SessionFile['source']> = {
  Read: 'read',
  Edit: 'edited',
  MultiEdit: 'edited',
  NotebookEdit: 'edited',
  Write: 'written',
}
const RANK = { read: 0, upload: 1, edited: 2, written: 3 }

/**
 * Files a chat touched, newest first: uploads and @-mentions in user messages
 * and file tools in the transcript. A file keeps its strongest action.
 */
export function sessionFiles(items: Item[]): SessionFile[] {
  const found = new Map<string, SessionFile['source']>()
  const add = (path: string, source: SessionFile['source']) => {
    const prev = found.get(path)
    found.delete(path)
    found.set(path, prev && RANK[prev] > RANK[source] ? prev : source)
  }
  for (const item of items) {
    if (item.kind === 'user') {
      for (const seg of splitMentions(item.text)) {
        if ('path' in seg) add(seg.path, /[\\/]web[\\/]uploads[\\/]/.test(seg.path) ? 'upload' : 'read')
      }
    }
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      const source = block?.kind === 'tool' ? TOOL_SOURCE[block.name] : undefined
      if (!source || block?.kind !== 'tool') continue
      try {
        const input = JSON.parse(block.input) as { file_path?: unknown; notebook_path?: unknown }
        const path = input.file_path ?? input.notebook_path
        if (typeof path === 'string') add(path, source)
      } catch {
        // Input still streaming.
      }
    }
  }
  return [...found].reverse().map(([path, source]) => ({ path, source }))
}
