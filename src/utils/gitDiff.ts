import type { StructuredPatchHunk } from 'diff'
import type { Dirent } from 'fs'
import { lstat, readdir, readFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { getCwd } from './cwd.js'
import { getCachedRepository } from './detectRepository.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { isFileWithinReadSizeLimit } from './file.js'
import { findGitRoot, getDefaultBranch, gitExe } from './git.js'

export type GitDiffStats = {
  filesCount: number
  linesAdded: number
  linesRemoved: number
}

export type PerFileStats = {
  added: number
  removed: number
  isBinary: boolean
  isUntracked?: boolean
}

export type GitDiffResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
  hunks: Map<string, StructuredPatchHunk[]>
}

const GIT_TIMEOUT_MS = 5000
const MAX_FILES = 50
const MAX_DIFF_SIZE_BYTES = 1_000_000 // 1 MB - skip files larger than this
const MAX_LINES_PER_FILE = 400 // GitHub's auto-load limit
const MAX_FILES_FOR_DETAILS = 500 // Skip per-file details if more files than this
const GIT_OUTPUT_CAP_BYTES = 4 * 1024 * 1024

export type DiffBaseMode = 'session' | 'uncommitted' | 'branch'

export type DiffEntry = PerFileStats & {
  path: string
  renamedFrom: string | null
  isUntracked: boolean
  isPreSession: boolean
}

export type DiffBody = {
  status:
    | 'loading'
    | 'ready'
    | 'unavailable'
    | 'binary'
    | 'no-body'
    | 'large'
    | 'truncated'
  hunks: StructuredPatchHunk[]
  reason?: string
}

export type DiffSnapshot = {
  root: string
  mode: DiffBaseMode
  stats: GitDiffStats
  files: DiffEntry[]
  source:
    | { kind: 'working-tree'; base: 'HEAD' }
    | { kind: 'branch'; baseBranch: string; baseRef: string }
  baseRef: string
  isUnborn: boolean
  stalePaths: string[]
  isUntrackedWithheld: boolean
  detailsOmitted: boolean
}

export type DiffFetchOutcome =
  | { kind: 'data'; data: DiffSnapshot }
  | { kind: 'transient'; reason: string }
  | { kind: 'unavailable'; reason: string }

export type GitDiffBackend = {
  root: string
  fetch(mode: DiffBaseMode, signal?: AbortSignal): Promise<DiffFetchOutcome>
  fetchBody(
    data: DiffSnapshot,
    file: DiffEntry,
    signal?: AbortSignal,
  ): Promise<DiffBody>
  headKey(signal?: AbortSignal): Promise<string | null>
}

/** Probe only when called; the controller owns lazy creation and negative caching. */
export async function createGitDiffBackend({
  cwd,
  sessionStartMs,
  signal,
}: {
  cwd: string
  sessionStartMs: number
  signal?: AbortSignal
}): Promise<GitDiffBackend | null> {
  const run = (
    args: string[],
    root = cwd,
    gitDir?: string,
    abortSignal = signal,
    maxBuffer = GIT_OUTPUT_CAP_BYTES,
  ) =>
    execFileNoThrowWithCwd(
      gitExe(),
      [
        '--no-optional-locks',
        ...(gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${root}`] : []),
        ...args,
      ],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer,
        abortSignal,
        env: {
          LC_ALL: 'C',
          LANG: 'C',
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
        },
      },
    )
  const probe = await run(['rev-parse', '--show-toplevel'])
  if (probe.code !== 0) {
    if (/not a git repository|must be run in a work tree/.test(probe.stderr))
      return null
    throw new Error('Git repository probe unavailable')
  }
  const root = probe.stdout
  const directory = await run(['rev-parse', '--absolute-git-dir'], root)
  if (directory.code !== 0) throw new Error('Git directory probe unavailable')
  const pinned = (
    args: string[],
    abortSignal?: AbortSignal,
    maxBuffer?: number,
  ) => run(args, root, directory.stdout, abortSignal, maxBuffer)
  let baseline: Promise<Set<string> | null> | undefined
  async function readBaseline(abortSignal?: AbortSignal) {
    const result = await pinned(
      [
        'status',
        '--porcelain',
        '-z',
        '--untracked-files=all',
        '--no-renames',
        '--ignore-submodules=dirty',
      ],
      abortSignal,
    )
    return wholeListing(result)
      ? new Set(
          result.stdout
            .split('\0')
            .filter(Boolean)
            .map(record => record.slice(3)),
        )
      : null
  }
  const diffArgs = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--ignore-submodules=dirty',
  ]
  async function readStats(baseRef: string, abortSignal?: AbortSignal) {
    const short = await pinned(
      [...diffArgs, baseRef, '--shortstat'],
      abortSignal,
    )
    const stats = short.code === 0 ? parseShortstat(short.stdout) : null
    if (stats && stats.filesCount > MAX_FILES_FOR_DETAILS)
      return { stats, files: [] as DiffEntry[] }
    const result = await pinned(
      [...diffArgs, baseRef, '--numstat', '-z'],
      abortSignal,
    )
    if (!wholeListing(result)) return null
    const parsed = parseNulNumstat(result.stdout)
    return parsed.valid ? parsed : null
  }
  async function branchSource(
    abortSignal?: AbortSignal,
  ): Promise<DiffSnapshot['source'] | null> {
    const branch = await pinned(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      abortSignal,
    )
    if (branch.code === 1 && !executionFailed(branch))
      return { kind: 'working-tree', base: 'HEAD' }
    if (branch.code !== 0) return null
    const symref = await pinned(
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      abortSignal,
    )
    if (executionFailed(symref)) return null
    let baseBranch = 'main'
    const named =
      symref.code === 0 ? symref.stdout.replace(/^origin\//, '') : ''
    for (const candidate of [
      ...new Set([named, 'main', 'master'].filter(Boolean)),
    ]) {
      const ref = await pinned(
        ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
        abortSignal,
      )
      if (executionFailed(ref) || (ref.code !== 0 && ref.code !== 1))
        return null
      if (ref.code === 0) {
        baseBranch = candidate
        break
      }
    }
    if (branch.stdout === baseBranch)
      return { kind: 'branch', baseBranch, baseRef: 'HEAD' }
    const bases: string[] = []
    for (const ref of [
      `refs/remotes/origin/${baseBranch}`,
      `refs/heads/${baseBranch}`,
    ]) {
      const exists = await pinned(
        ['show-ref', '--verify', '--quiet', ref],
        abortSignal,
      )
      if (executionFailed(exists) || (exists.code !== 0 && exists.code !== 1))
        return null
      if (exists.code === 1) continue
      const base = await pinned(['merge-base', 'HEAD', ref], abortSignal)
      if (executionFailed(base)) return null
      if (base.code === 1) continue
      if (base.code !== 0 || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(base.stdout))
        return null
      bases.push(base.stdout)
    }
    if (!bases.length) return { kind: 'working-tree', base: 'HEAD' }
    let baseRef = bases[0]!
    if (bases[1] && bases[1] !== baseRef) {
      const newer = await pinned(
        ['merge-base', '--is-ancestor', baseRef, bases[1]],
        abortSignal,
      )
      if (executionFailed(newer) || newer.code > 1) return null
      if (newer.code === 0) baseRef = bases[1]
    }
    return { kind: 'branch', baseBranch, baseRef }
  }
  return {
    root,
    async fetch(mode, abortSignal) {
      if (abortSignal?.aborted || signal?.aborted)
        return { kind: 'unavailable', reason: 'aborted' }
      try {
        const names = await readdir(directory.stdout)
        if (
          names.some(name =>
            [
              'MERGE_HEAD',
              'REBASE_HEAD',
              'CHERRY_PICK_HEAD',
              'REVERT_HEAD',
              'rebase-merge',
              'rebase-apply',
            ].includes(name),
          )
        ) {
          return { kind: 'transient', reason: 'git-operation-in-progress' }
        }
      } catch {
        return { kind: 'unavailable', reason: 'git-directory-unavailable' }
      }
      baseline ??= readBaseline(abortSignal)
      const dirty = await baseline
      let source: DiffSnapshot['source'] | null =
        mode === 'branch'
          ? await branchSource(abortSignal)
          : { kind: 'working-tree', base: 'HEAD' }
      let baseRef = source?.kind === 'branch' ? source.baseRef : 'HEAD'
      let isUnborn = false
      const stalePaths: string[] = []
      if (baseRef === 'HEAD') {
        const head = await pinned(
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          abortSignal,
        )
        if (executionFailed(head) || (head.code !== 0 && head.code !== 1))
          return { kind: 'unavailable', reason: 'head-unavailable' }
        if (head.code === 0) {
          baseRef = head.stdout
          if (source?.kind === 'branch') source = { ...source, baseRef }
        }
      }
      let parsed = source ? await readStats(baseRef, abortSignal) : null
      if (!parsed) {
        const head = await pinned(
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          abortSignal,
        )
        const symbolic = await pinned(
          ['symbolic-ref', '-q', 'HEAD'],
          abortSignal,
        )
        if (head.code !== 1 || executionFailed(head) || symbolic.code !== 0)
          return { kind: 'unavailable', reason: 'stats-failed' }
        const ref = await pinned(
          ['show-ref', '--verify', '--quiet', symbolic.stdout],
          abortSignal,
        )
        if (ref.code !== 1 || executionFailed(ref))
          return { kind: 'unavailable', reason: 'head-unavailable' }
        isUnborn = true
        source = { kind: 'working-tree', base: 'HEAD' }
        baseRef = '--cached'
        parsed = await readStats(baseRef, abortSignal)
        if (!parsed)
          return { kind: 'unavailable', reason: 'staged-stats-failed' }
        if (parsed.files.length) {
          const result = await pinned(
            [...diffArgs, '--numstat', '-z'],
            abortSignal,
          )
          if (!wholeListing(result))
            return { kind: 'unavailable', reason: 'unstaged-stats-failed' }
          const unstaged = parseNulNumstat(
            result.stdout,
            Number.POSITIVE_INFINITY,
          )
          if (!unstaged.valid)
            return { kind: 'unavailable', reason: 'unstaged-stats-failed' }
          const edits = unstaged.files
          stalePaths.push(...edits.map(file => file.path))
          for (const file of parsed.files) {
            const edit = edits.find(edit => edit.path === file.path)
            if (!edit) continue
            file.isBinary ||= edit.isBinary
            const added = file.isBinary
              ? 0
              : Math.max(0, file.added + edit.added - edit.removed)
            parsed.stats.linesAdded += added - file.added
            file.added = added
            file.removed = 0
          }
        }
      }
      const detailsOmitted = parsed.stats.filesCount > MAX_FILES_FOR_DETAILS
      const stamp = fileStampProbe(root)
      const isPreSession = async (path: string, untracked: boolean) => {
        const time = await stamp(path)
        return time === 'over-budget'
          ? untracked
          : time !== null && time < sessionStartMs && (dirty?.has(path) ?? true)
      }
      if (mode === 'session' && !isUnborn) {
        for (const file of parsed.files)
          file.isPreSession = await isPreSession(file.path, false)
      }
      let isUntrackedWithheld = false
      if (!detailsOmitted && parsed.files.length < MAX_FILES) {
        const listing = await pinned(
          ['ls-files', '-z', '--others', '--exclude-standard', '--full-name'],
          abortSignal,
        )
        isUntrackedWithheld = !wholeListing(listing)
        if (!isUntrackedWithheld) {
          const paths = listing.stdout.split('\0').filter(Boolean)
          const untracked: DiffEntry[] = []
          for (const [index, path] of paths.entries()) {
            untracked.push({
              path,
              renamedFrom: null,
              added: 0,
              removed: 0,
              isBinary: false,
              isUntracked: true,
              isPreSession: index >= 500 || (await isPreSession(path, true)),
            })
          }
          const visible = [
            ...untracked.filter(file => !file.isPreSession),
            ...(mode === 'session' && !isUnborn
              ? untracked.filter(file => file.isPreSession)
              : []),
          ].slice(0, MAX_FILES - parsed.files.length)
          parsed.files.push(...visible)
          parsed.stats.filesCount += visible.length
        }
      }
      if (abortSignal?.aborted || signal?.aborted)
        return { kind: 'unavailable', reason: 'aborted' }
      return {
        kind: 'data',
        data: {
          root,
          mode,
          stats: parsed.stats,
          files: parsed.files,
          source: source!,
          baseRef,
          isUnborn,
          stalePaths,
          isUntrackedWithheld,
          detailsOmitted,
        },
      }
    },
    async fetchBody(data, file, abortSignal) {
      if (abortSignal?.aborted || signal?.aborted)
        return { status: 'unavailable', hunks: [], reason: 'aborted' }
      if (data.detailsOmitted)
        return { status: 'no-body', hunks: [], reason: 'details-omitted' }
      if (
        data.root !== root ||
        !data.files.slice(0, MAX_FILES).some(entry => entry.path === file.path)
      ) {
        return {
          status: 'unavailable',
          hunks: [],
          reason: 'file-not-in-snapshot',
        }
      }
      if (file.isBinary) return { status: 'binary', hunks: [] }
      if (
        file.isUntracked ||
        file.renamedFrom !== null ||
        data.stalePaths.includes(file.path)
      ) {
        return { status: 'no-body', hunks: [] }
      }
      const stat = await lstat(join(root, file.path)).catch(() => null)
      if (stat?.isFile() && stat.size > MAX_DIFF_SIZE_BYTES)
        return { status: 'large', hunks: [] }
      // The deleted/base side can be large even when today's working file is tiny.
      const object = await pinned(
        [
          'cat-file',
          '-s',
          data.isUnborn ? `:${file.path}` : `${data.baseRef}:${file.path}`,
        ],
        abortSignal,
      )
      if (executionFailed(object))
        return { status: 'unavailable', hunks: [], reason: 'size-probe-failed' }
      if (object.code === 0 && Number(object.stdout) > MAX_DIFF_SIZE_BYTES)
        return { status: 'large', hunks: [] }
      const result = await pinned(
        ['--literal-pathspecs', ...diffArgs, data.baseRef, '--', file.path],
        abortSignal,
        MAX_DIFF_SIZE_BYTES + 1,
      )
      if (
        Buffer.byteLength(result.stdout) > MAX_DIFF_SIZE_BYTES ||
        result.error?.includes('maxBuffer')
      )
        return { status: 'large', hunks: [] }
      if (result.code !== 0)
        return { status: 'unavailable', hunks: [], reason: 'body-failed' }
      return parseFileBody(result.stdout)
    },
    async headKey(abortSignal) {
      const head = await pinned(
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        abortSignal,
      )
      const ref = await pinned(['symbolic-ref', '--quiet', 'HEAD'], abortSignal)
      if (
        executionFailed(head) ||
        executionFailed(ref) ||
        head.code > 1 ||
        ref.code > 1
      )
        return null
      return `${ref.code === 0 ? ref.stdout : 'detached'}|${head.code === 0 ? head.stdout : 'unborn'}`
    },
  }
}

function executionFailed(result: { error?: string }): boolean {
  return (
    !!result.error && !result.error.startsWith('Command failed with exit code ')
  )
}

function wholeListing(result: { code: number; stdout: string }): boolean {
  return (
    result.code === 0 &&
    Buffer.byteLength(result.stdout) < GIT_OUTPUT_CAP_BYTES &&
    (result.stdout === '' || result.stdout.endsWith('\0'))
  )
}

/** Date only real files under real directories, with a shared per-fetch budget. */
function fileStampProbe(root: string) {
  const directories = new Map<string, Dirent[]>()
  return async (path: string): Promise<number | null | 'over-budget'> => {
    const parts = path.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..'))
      return null
    let directory = root
    try {
      for (const [index, part] of parts.entries()) {
        let listing = directories.get(directory)
        if (!listing) {
          if (directories.size >= 512) return 'over-budget'
          // Keep entry kinds: never follow a symlink merely to classify its timestamp.
          listing = await readdir(directory, { withFileTypes: true }).catch(
            () => [],
          )
          directories.set(directory, listing)
        }
        const entry = listing.find(entry => entry.name === part)
        const leaf = index === parts.length - 1
        if (!entry || (leaf ? !entry.isFile() : !entry.isDirectory()))
          return null
        directory = join(directory, part)
      }
      const stat = await lstat(directory)
      return stat.isFile() ? stat.mtimeMs : null
    } catch {
      return null
    }
  }
}

function parseNulNumstat(
  stdout: string,
  limit = MAX_FILES,
): { stats: GitDiffStats; files: DiffEntry[]; valid: boolean } {
  const records = stdout.split('\0')
  const stats = { filesCount: 0, linesAdded: 0, linesRemoved: 0 }
  const files: DiffEntry[] = []
  let valid = stdout === '' || stdout.endsWith('\0')
  for (let index = 0; index < records.length - 1; index++) {
    const match = records[index]!.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/)
    if (!match) {
      valid = false
      break
    }
    let path = match[3]!
    let renamedFrom: string | null = null
    if (path === '') {
      renamedFrom = records[++index] ?? null
      path = records[++index] ?? ''
    }
    if (!path || renamedFrom === '') {
      valid = false
      break
    }
    const isBinary = match[1] === '-' || match[2] === '-'
    const added = isBinary ? 0 : Number(match[1])
    const removed = isBinary ? 0 : Number(match[2])
    stats.filesCount++
    stats.linesAdded += added
    stats.linesRemoved += removed
    if (files.length < limit)
      files.push({
        path,
        renamedFrom,
        added,
        removed,
        isBinary,
        isUntracked: false,
        isPreSession: false,
      })
  }
  return { stats, files, valid }
}

function parseFileBody(stdout: string): DiffBody {
  if (Buffer.byteLength(stdout) > MAX_DIFF_SIZE_BYTES)
    return { status: 'large', hunks: [] }
  const hunks: StructuredPatchHunk[] = []
  let current: StructuredPatchHunk | undefined
  let count = 0
  let truncated = false
  for (const line of stdout.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        lines: [],
      }
      if (count < MAX_LINES_PER_FILE) hunks.push(current)
    } else if (
      current &&
      (/^[ +\-]/.test(line) || line === '\\ No newline at end of file')
    ) {
      if (count < MAX_LINES_PER_FILE) current.lines.push(line)
      else truncated = true
      count++
    } else if (line.startsWith('diff --git ')) current = undefined
  }
  return {
    status: truncated ? 'truncated' : hunks.length ? 'ready' : 'no-body',
    hunks,
  }
}

/**
 * Fetch git diff stats and hunks comparing working tree to HEAD.
 * Returns null if not in a git repo or if git commands fail.
 *
 * Returns null during merge/rebase/cherry-pick/revert operations since the
 * working tree contains incoming changes that weren't intentionally
 * made by the user.
 */
export async function fetchGitDiff(): Promise<GitDiffResult | null> {
  try {
    // Legacy callers list all untracked files, regardless of session start.
    const backend = await createGitDiffBackend({
      cwd: getCwd(),
      sessionStartMs: 0,
    })
    const outcome = await backend?.fetch('uncommitted')
    if (outcome?.kind !== 'data') return null
    return {
      stats: outcome.data.stats,
      perFileStats: new Map(
        outcome.data.files.map(file => [
          file.path,
          {
            added: file.added,
            removed: file.removed,
            isBinary: file.isBinary,
            ...(file.isUntracked && { isUntracked: true }),
          },
        ]),
      ),
      hunks: new Map(),
    }
  } catch {
    return null
  }
}

/** Legacy on-demand entry point, now subject to the same admission limits. */
export async function fetchGitDiffHunks(): Promise<
  Map<string, StructuredPatchHunk[]>
> {
  const result = new Map<string, StructuredPatchHunk[]>()
  try {
    const backend = await createGitDiffBackend({
      cwd: getCwd(),
      sessionStartMs: 0,
    })
    if (!backend) return result
    const outcome = await backend.fetch('uncommitted')
    if (outcome.kind !== 'data') return result
    for (const file of outcome.data.files) {
      const body = await backend.fetchBody(outcome.data, file)
      if (body.hunks.length) result.set(file.path, body.hunks)
    }
  } catch {
    /* Legacy callers expect an empty map when Git is unavailable. */
  }
  return result
}

export type NumstatResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
}

/**
 * Parse git diff --numstat output into stats.
 * Format: <added>\t<removed>\t<filename>
 * Binary files show '-' for counts.
 * Only stores first MAX_FILES entries in perFileStats.
 */
export function parseGitNumstat(stdout: string): NumstatResult {
  if (stdout.includes('\0')) {
    const parsed = parseNulNumstat(stdout)
    return {
      stats: parsed.stats,
      perFileStats: new Map(
        parsed.files.map(file => [
          file.path,
          { added: file.added, removed: file.removed, isBinary: file.isBinary },
        ]),
      ),
    }
  }
  const lines = stdout.trim().split('\n').filter(Boolean)
  let added = 0
  let removed = 0
  let validFileCount = 0
  const perFileStats = new Map<string, PerFileStats>()

  for (const line of lines) {
    const parts = line.split('\t')
    // Valid numstat lines have exactly 3 tab-separated parts: added, removed, filename
    if (parts.length < 3) continue

    validFileCount++
    const addStr = parts[0]
    const remStr = parts[1]
    const filePath = parts.slice(2).join('\t') // filename may contain tabs
    const isBinary = addStr === '-' || remStr === '-'
    const fileAdded = isBinary ? 0 : parseInt(addStr ?? '0', 10) || 0
    const fileRemoved = isBinary ? 0 : parseInt(remStr ?? '0', 10) || 0

    added += fileAdded
    removed += fileRemoved

    // Only store first MAX_FILES entries
    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(filePath, {
        added: fileAdded,
        removed: fileRemoved,
        isBinary,
      })
    }
  }

  return {
    stats: {
      filesCount: validFileCount,
      linesAdded: added,
      linesRemoved: removed,
    },
    perFileStats,
  }
}

/**
 * Parse unified diff output into per-file hunks.
 * Splits by "diff --git" and parses each file's hunks.
 *
 * Applies limits:
 * - MAX_FILES: stop after this many files
 * - Files >1MB: skipped entirely (not in result map)
 * - Files ≤1MB: parsed but limited to MAX_LINES_PER_FILE lines
 */
export function parseGitDiff(
  stdout: string,
): Map<string, StructuredPatchHunk[]> {
  const result = new Map<string, StructuredPatchHunk[]>()
  for (const chunk of stdout.split(/^diff --git /m).filter(Boolean)) {
    if (result.size >= MAX_FILES) break
    const header = chunk.split('\n', 1)[0] ?? ''
    const destination = header.match(/ ("b\/(?:\\.|[^"])*"|b\/.*)$/)?.[1]
    if (!destination) continue
    const path = decodeGitPath(destination).slice(2)
    const body = parseFileBody(chunk)
    if (body.hunks.length) result.set(path, body.hunks)
  }
  return result
}

function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path
  const bytes: number[] = []
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
  }
  const text = path.slice(1, -1)
  for (let index = 0; index < text.length; index++) {
    let char = text[index]!
    if (char === '\\') {
      const octal = /^[0-7]{3}/.exec(text.slice(index + 1))
      if (octal) {
        bytes.push(parseInt(octal[0], 8))
        index += 3
        continue
      }
      char = text[++index] ?? ''
      char = escapes[char] ?? char
    }
    const code = text.codePointAt(index)
    if (code && code > 0xffff) {
      char = String.fromCodePoint(code)
      index++
    }
    bytes.push(...Buffer.from(char))
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Parse git diff --shortstat output into stats.
 * Format: " 1648 files changed, 52341 insertions(+), 8123 deletions(-)"
 *
 * This is O(1) memory regardless of diff size - git computes totals without
 * loading all content. Used as a quick probe before expensive operations.
 */
export function parseShortstat(stdout: string): GitDiffStats | null {
  // Match: "N files changed" with optional ", N insertions(+)" and ", N deletions(-)"
  const match = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  )
  if (!match) return null
  return {
    filesCount: parseInt(match[1] ?? '0', 10),
    linesAdded: parseInt(match[2] ?? '0', 10),
    linesRemoved: parseInt(match[3] ?? '0', 10),
  }
}

const SINGLE_FILE_DIFF_TIMEOUT_MS = 3000

export type ToolUseDiff = {
  filename: string
  status: 'modified' | 'added'
  additions: number
  deletions: number
  changes: number
  patch: string
  /** GitHub "owner/repo" when available (null for non-github.com or unknown repos) */
  repository: string | null
}

/**
 * Fetch a structured diff for a single file against the merge base with the
 * default branch. This produces a PR-like diff showing all changes since
 * the branch diverged. Falls back to diffing against HEAD if the merge base
 * cannot be determined (e.g., on the default branch itself).
 * For untracked files, generates a synthetic diff showing all additions.
 * Returns null if not in a git repo or if git commands fail.
 */
export async function fetchSingleFileGitDiff(
  absoluteFilePath: string,
): Promise<ToolUseDiff | null> {
  const gitRoot = findGitRoot(dirname(absoluteFilePath))
  if (!gitRoot) return null

  const gitPath = relative(gitRoot, absoluteFilePath).split(sep).join('/')
  const repository = getCachedRepository()

  // Check if the file is tracked by git
  const { code: lsFilesCode } = await execFileNoThrowWithCwd(
    gitExe(),
    [
      '--no-optional-locks',
      '--literal-pathspecs',
      'ls-files',
      '--error-unmatch',
      '--',
      gitPath,
    ],
    { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
  )

  if (lsFilesCode === 0) {
    // File is tracked - diff against merge base for PR-like view
    const diffRef = await getDiffRef(gitRoot)
    const { stdout, code } = await execFileNoThrowWithCwd(
      gitExe(),
      [
        '--no-optional-locks',
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        diffRef,
        '--',
        gitPath,
      ],
      { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
    )
    if (code !== 0) return null
    if (!stdout) return null
    return {
      ...parseRawDiffToToolUseDiff(gitPath, stdout, 'modified'),
      repository,
    }
  }

  // File is untracked - generate synthetic diff
  const syntheticDiff = await generateSyntheticDiff(gitPath, absoluteFilePath)
  if (!syntheticDiff) return null
  return { ...syntheticDiff, repository }
}

/**
 * Parse raw unified diff output into the structured ToolUseDiff format.
 * Extracts only the hunk content (starting from @@) as the patch,
 * and counts additions/deletions.
 */
function parseRawDiffToToolUseDiff(
  filename: string,
  rawDiff: string,
  status: 'modified' | 'added',
): Omit<ToolUseDiff, 'repository'> {
  const lines = rawDiff.split('\n')
  const patchLines: string[] = []
  let inHunks = false
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunks = true
    }
    if (inHunks) {
      patchLines.push(line)
      if (line.startsWith('+')) {
        additions++
      } else if (line.startsWith('-')) {
        deletions++
      }
    }
  }

  return {
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    patch: patchLines.join('\n'),
  }
}

/**
 * Determine the best ref to diff against for a PR-like diff.
 * Priority:
 * 1. CLAUDE_CODE_BASE_REF env var (set externally, e.g. by CCR managed containers)
 * 2. Merge base with the default branch (best guess)
 * 3. HEAD (fallback if merge-base fails)
 */
async function getDiffRef(gitRoot: string): Promise<string> {
  const baseBranch =
    process.env.CLAUDE_CODE_BASE_REF || (await getDefaultBranch())
  const { stdout, code } = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'merge-base', 'HEAD', baseBranch],
    { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
  )
  if (code === 0 && stdout.trim()) {
    return stdout.trim()
  }
  return 'HEAD'
}

async function generateSyntheticDiff(
  gitPath: string,
  absoluteFilePath: string,
): Promise<Omit<ToolUseDiff, 'repository'> | null> {
  try {
    if (!isFileWithinReadSizeLimit(absoluteFilePath, MAX_DIFF_SIZE_BYTES)) {
      return null
    }
    const content = await readFile(absoluteFilePath, 'utf-8')
    const lines = content.split('\n')
    // Remove trailing empty line from split if file ends with newline
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop()
    }
    const lineCount = lines.length
    const addedLines = lines.map(line => `+${line}`).join('\n')
    const patch = `@@ -0,0 +1,${lineCount} @@\n${addedLines}`
    return {
      filename: gitPath,
      status: 'added',
      additions: lineCount,
      deletions: 0,
      changes: lineCount,
      patch,
    }
  } catch {
    return null
  }
}
