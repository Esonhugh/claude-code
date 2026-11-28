import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseConfigString } from '../utils/git/gitConfigParser.js'

type GithubRow = { number: number; title: string; url: string }
export type GithubIssue = GithubRow & { state: 'open' | 'closed' | 'completed' | 'not_planned' }
export type GithubPull = GithubRow & { state: 'open' | 'draft' | 'rejected' | 'merged'; closingIssues: GithubIssue[] }
export type ProjectGithub =
  | { status: 'ok'; issues: GithubIssue[]; pulls: GithubPull[] }
  | { status: 'unsupported' | 'gh_missing' | 'error' }

const ROW_LIMIT = 12
const REFERENCE_LIMIT = 10
// Unlike gh pr list's JSON references, this includes each cited issue's metadata in the same query.
const PULL_QUERY = `query($owner: String!, $repo: String!, $limit: Int!, $refs: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    pullRequests(first: $limit, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title state url isDraft
        closingIssuesReferences(first: $refs) {
          nodes { number title state stateReason url repository { nameWithOwner } }
        }
      }
    }
  }
}`
const GIT_METADATA_LIMIT = 256 * 1024
const run = promisify(execFile)
const remotePattern = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})$/i

function slugForRemote(remote: string | null): string | undefined {
  const match = remotePattern.exec(remote?.trim() ?? '')
  const repo = match?.[2]?.replace(/\.git$/i, '')
  if (!match || !repo || repo === '.' || repo === '..') return undefined
  return `${match[1]}/${repo}`
}

/** Read ordinary Git metadata, rejecting the whole file rather than parsing a prefix. */
async function readGitMetadata(path: string): Promise<string | undefined> {
  try {
    const named = await lstat(path)
    if (!named.isFile() || named.size > GIT_METADATA_LIMIT) throw new Error('Unsupported Git metadata')
    const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > GIT_METADATA_LIMIT) throw new Error('Unsupported Git metadata')
      const bytes = Buffer.allocUnsafe(GIT_METADATA_LIMIT + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) return bytes.toString('utf8', 0, offset)
        offset += bytesRead
      }
      throw new Error('Oversized Git metadata')
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function projectOrigin(cwd: string): Promise<string | null> {
  // Stay at the selected root; support the .git/commondir pointers of linked worktrees.
  const dotGit = join(cwd, '.git')
  let gitDir = dotGit
  if (!(await lstat(dotGit)).isDirectory()) {
    const pointer = (await readGitMetadata(dotGit))?.trim().match(/^gitdir: ([^\r\n\0]+)$/)
    if (!pointer?.[1]) return null
    gitDir = resolve(cwd, pointer[1])
  }
  const originAt = async (dir: string) => parseConfigString(await readGitMetadata(join(dir, 'config')) ?? '', 'remote', 'origin', 'url')
  const direct = await originAt(gitDir)
  if (direct) return direct
  const common = (await readGitMetadata(join(gitDir, 'commondir')))?.trim()
  return common && !/[\r\n\0]/.test(common) && resolve(gitDir, common) !== gitDir
    ? originAt(resolve(gitDir, common)) : null
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub object')
  return value as Record<string, unknown>
}

function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid GitHub list')
  return value
}

function parseRow({ number, title, url }: Record<string, unknown>, slug: string, kind: 'issues' | 'pull'): GithubRow {
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || typeof title !== 'string') {
    throw new Error('Invalid GitHub row')
  }
  const canonical = `https://github.com/${slug}/${kind}/${number}`
  // Reject redirects and unexpected URLs; never forward a URL supplied by gh.
  if (typeof url !== 'string' || url.toLowerCase() !== canonical.toLowerCase()) throw new Error('Unexpected GitHub row URL')
  return { number, title: title.replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ').trim().slice(0, 240), url: canonical }
}

function parseIssue(row: Record<string, unknown>, slug: string): GithubIssue {
  if (row.state !== 'OPEN' && row.state !== 'CLOSED') throw new Error('Invalid GitHub issue state')
  if (row.stateReason != null && typeof row.stateReason !== 'string') throw new Error('Invalid GitHub issue state reason')
  const state = row.state === 'OPEN' ? 'open'
    : row.stateReason === 'COMPLETED' ? 'completed'
      : row.stateReason === 'NOT_PLANNED' ? 'not_planned' : 'closed'
  return { ...parseRow(row, slug, 'issues'), state }
}

function parsePulls(stdout: string, slug: string): GithubPull[] {
  const graph = record(JSON.parse(stdout))
  if (graph.errors !== undefined) throw new Error('GitHub query error')
  const repository = record(record(graph.data).repository)
  const lowerSlug = slug.toLowerCase()
  if (typeof repository.nameWithOwner !== 'string' || repository.nameWithOwner.toLowerCase() !== lowerSlug) {
    throw new Error('Unexpected GitHub repository')
  }
  return list(record(repository.pullRequests).nodes, ROW_LIMIT).map(value => {
    const row = record(value)
    const state = row.state === 'MERGED' ? 'merged' : row.state === 'CLOSED' ? 'rejected'
      : row.state === 'OPEN' && typeof row.isDraft === 'boolean' ? (row.isDraft ? 'draft' : 'open') : undefined
    if (!state) throw new Error('Invalid GitHub pull state')
    const closing = new Map<number, GithubIssue>()
    for (const value of list(record(row.closingIssuesReferences).nodes, REFERENCE_LIMIT)) {
      const ref = record(value)
      const { nameWithOwner } = record(ref.repository)
      if (typeof nameWithOwner !== 'string') throw new Error('Invalid GitHub reference repository')
      // Numbers are repository-local; a foreign reference cannot match any issue in this panel.
      if (nameWithOwner.toLowerCase() !== lowerSlug) continue
      const issue = parseIssue(ref, slug)
      closing.set(issue.number, issue)
    }
    return { ...parseRow(row, slug, 'pull'), state, closingIssues: [...closing.values()] }
  })
}

/** The caller supplies a project root already resolved and trusted by the host. */
export async function readProjectGithub(cwd: string, signal?: AbortSignal): Promise<ProjectGithub> {
  try {
    const slug = slugForRemote(await projectOrigin(cwd).catch(() => null))
    if (!slug) return { status: 'unsupported' }
    const base = homedir()
    const path = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(isAbsolute)
    const gh = Bun.which('gh', { PATH: path.join(process.platform === 'win32' ? ';' : ':'), cwd: base })
    if (!gh) return { status: 'gh_missing' }
    const options = {
      cwd: base,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', GH_PAGER: 'cat', GH_DEBUG: '' },
      timeout: 5000,
      maxBuffer: 128 * 1024,
      killSignal: 'SIGKILL' as const,
      signal,
      windowsHide: true,
    }
    const [owner, repo] = slug.split('/') as [string, string]
    const [issues, pulls] = await Promise.all([
      run(gh, ['issue', 'list', '--repo', `github.com/${slug}`, '--state', 'all', '--limit', String(ROW_LIMIT),
        '--json', 'number,title,state,url,stateReason'], options),
      run(gh, ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${PULL_QUERY}`, '-f', `owner=${owner}`,
        '-f', `repo=${repo}`, '-F', `limit=${ROW_LIMIT}`, '-F', `refs=${REFERENCE_LIMIT}`], options),
    ])
    return { status: 'ok', issues: list(JSON.parse(issues.stdout), ROW_LIMIT).map(value => parseIssue(record(value), slug)),
      pulls: parsePulls(pulls.stdout, slug) }
  } catch {
    // Error text may contain authentication or local configuration details.
    return { status: 'error' }
  }
}
