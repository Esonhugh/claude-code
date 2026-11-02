import type { Database } from 'bun:sqlite'
import { readdir, readFile, realpath, rm, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { listCandidates, parseSessionInfoFromLite } from '../utils/listSessionsImpl.js'
import {
  extractJsonStringField,
  getProjectsDir,
  readSessionLite,
  resolveSessionFilePath,
} from '../utils/sessionStoragePortable.js'
import { readFolders, readSessionMeta, type SessionMeta, touchFolders } from './projectsDb.js'

/** One session row of `GET /api/sidebar`. */
export type SidebarSession = {
  id: string
  title: string
  /** Where `title` came from: a title (renamed or generated), the last message, or neither (the id). */
  label: 'title' | 'message' | 'id'
  cwd?: string
  lastModified: number
  pinnedAt?: number
  unread?: true
  /** Left out of the list; search still finds it. */
  archived?: true
  projectId?: string
  /** Files the session wrote, when its transcript was scanned. */
  files?: number
}

export type SidebarData = {
  sessions: SidebarSession[]
  /** Folder path → last change: newest transcript or file the sessions there wrote. */
  folders: Record<string, number>
  /** More transcripts exist past `limit`. */
  more: boolean
}

type Transcript = {
  id: string
  filePath: string
  mtime: number
  size: number
  title?: string
  message?: string
  cwd?: string
}

// Transcripts this many from the top are scanned for the files they wrote.
const SCAN_FILES = 50
const SCAN_MAX_BYTES = 20 * 1024 * 1024
const READ_BATCH = 32

/** Title fallback: renamed title → transcript title → last message → session id. */
export function sessionTitle(
  id: string,
  t: { title?: string; message?: string },
  meta?: Pick<SessionMeta, 'title'>,
): Pick<SidebarSession, 'title' | 'label'> {
  const title = meta?.title || t.title
  if (title) return { title, label: 'title' }
  if (t.message) return { title: t.message, label: 'message' }
  return { title: id, label: 'id' }
}

async function readTranscriptInfo(c: { sessionId: string; filePath: string; mtime: number }): Promise<Transcript | null> {
  const lite = await readSessionLite(c.filePath)
  if (!lite) return null
  if (/"isSidechain":\s?true/.test(lite.head.split('\n', 1)[0]!)) return null
  const info = parseSessionInfoFromLite(c.sessionId, lite)
  return {
    id: c.sessionId,
    filePath: c.filePath,
    mtime: c.mtime,
    size: lite.size,
    // parseSessionInfoFromLite drops sessions without any prompt; those still list, by id.
    title: info?.customTitle,
    message: info?.customTitle ? undefined : info?.summary,
    cwd: info?.cwd ?? (extractJsonStringField(lite.head, 'cwd') || undefined),
  }
}

/** The newest `limit` transcripts, plus any in `always` (pinned) past that. */
async function listTranscripts(limit: number, always: Set<string>): Promise<{ list: Transcript[]; more: boolean }> {
  const projectsDir = getProjectsDir()
  const dirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => [])
  const candidates = (
    await Promise.all(dirs.filter(d => d.isDirectory()).map(d => listCandidates(join(projectsDir, d.name), true)))
  )
    .flat()
    .sort((a, b) => b.mtime - a.mtime)
  const read: Transcript[] = []
  const seen = new Set<string>()
  let more = false
  for (let i = 0; i < candidates.length; i += READ_BATCH) {
    let batch = candidates.slice(i, i + READ_BATCH)
    if (read.length >= limit) {
      more ||= batch.some(c => !always.has(c.sessionId))
      batch = batch.filter(c => always.has(c.sessionId))
    }
    for (const t of await Promise.all(batch.map(readTranscriptInfo))) {
      if (!t || seen.has(t.id)) continue
      seen.add(t.id)
      read.push(t)
    }
  }
  // A batch can overshoot `limit`; past it only pinned sessions stay.
  const list = read.filter((t, i) => i < limit || always.has(t.id))
  more ||= list.length < read.length
  return { list, more }
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const scanned = new Map<string, { key: string; files: string[] }>()

/** Paths the session's file tools wrote, cached by transcript mtime and size. */
async function writtenFiles(t: Transcript): Promise<string[] | undefined> {
  if (t.size > SCAN_MAX_BYTES) return undefined
  const key = `${t.mtime}:${t.size}`
  const hit = scanned.get(t.filePath)
  if (hit?.key === key) return hit.files
  const text = await readFile(t.filePath, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const files = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') || !line.includes('"type":"assistant"')) continue
    let entry: { message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (block.type !== 'tool_use' || !FILE_TOOLS.has(block.name ?? '') || !block.input) continue
      const path = block.input.file_path ?? block.input.notebook_path
      if (typeof path === 'string') files.add(path)
    }
  }
  scanned.set(t.filePath, { key, files: [...files] })
  return [...files]
}

async function newestMtime(paths: string[]): Promise<number> {
  const times = await Promise.all(paths.map(p => stat(p).then(s => s.mtimeMs, () => 0)))
  return Math.max(0, ...times)
}

/**
 * The sidebar's sessions with their marks, and each folder's last change
 * (also cached in the `folders` table, which only ever moves forward).
 */
export async function loadSidebar(db: Database, limit: number): Promise<SidebarData> {
  const meta = readSessionMeta(db)
  const pinned = new Set([...meta].filter(([, m]) => m.pinnedAt !== null).map(([id]) => id))
  const { list, more } = await listTranscripts(limit, pinned)
  const touched = new Map<string, number>()
  const touch = (cwd: string, at: number) => touched.set(cwd, Math.max(touched.get(cwd) ?? 0, at))
  const sessions: SidebarSession[] = []
  for (let i = 0; i < list.length; i += READ_BATCH) {
    const batch = list.slice(i, i + READ_BATCH)
    const files = await Promise.all(batch.map((t, j) => (i + j < SCAN_FILES ? writtenFiles(t) : undefined)))
    const fileTimes = await Promise.all(files.map(f => newestMtime(f ?? [])))
    batch.forEach((t, j) => {
      const m = meta.get(t.id)
      if (t.cwd) touch(t.cwd, Math.max(t.mtime, fileTimes[j]!))
      sessions.push({
        id: t.id,
        ...sessionTitle(t.id, t, m),
        ...(t.cwd && { cwd: t.cwd }),
        lastModified: t.mtime,
        ...(m?.pinnedAt != null && { pinnedAt: m.pinnedAt }),
        ...(m?.unread && { unread: true as const }),
        ...(m?.archivedAt != null && { archived: true as const }),
        ...(m?.projectId != null && { projectId: m.projectId }),
        ...(files[j] && { files: files[j].length }),
      })
    })
  }
  touchFolders(db, touched)
  const stored = readFolders(db)
  return {
    sessions,
    folders: Object.fromEntries([...touched.keys()].map(cwd => [cwd, stored.get(cwd) ?? touched.get(cwd)!])),
    more,
  }
}

/**
 * Deletes a session's transcript and its sibling folder (subagents, tool
 * results). Only a `<projects>/<dir>/<id>.jsonl` file is touched, after
 * symlinks are resolved. Returns false when there is no such transcript.
 */
export async function deleteTranscript(id: string): Promise<boolean> {
  const found = await resolveSessionFilePath(id)
  if (!found) return false
  const projectsDir = await realpath(getProjectsDir()).catch(() => undefined)
  const file = await realpath(found.filePath).catch(() => undefined)
  if (!projectsDir || !file || basename(file) !== `${id}.jsonl` || dirname(dirname(file)) !== projectsDir) {
    return false
  }
  await rm(file, { force: true })
  await rm(join(dirname(file), id), { recursive: true, force: true })
  return true
}
