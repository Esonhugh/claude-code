import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

const CACHE_ROOT_DIR = 'mcp-skill-archives'
const META_FILENAME = 'meta.json'
const SKILL_FILENAME = 'SKILL.md'
const META_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_MCP_SKILL_CONTENT_BYTES = 1024 * 1024

const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/u

type DiskCacheSkill = {
  name: string
  resourceUri: string
  digest?: string
  resources?: Array<{ uri: string; digest: string }>
}

type DiskCacheMeta = {
  uri?: string
  cacheKey: string
  declaredDigest?: string
  fetchedAt: number
}

export type McpSkillDiskCacheHit = {
  cacheKey: string
  skillMd: string
}

export function hashMcpSkillContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function cacheKeyForSkill(skill: DiskCacheSkill, contentHash?: string): string | null {
  if (skill.resources) {
    const hash = createHash('sha256')
    for (const resource of [...skill.resources].sort((a, b) =>
      a.uri.localeCompare(b.uri),
    )) {
      hash.update(resource.uri).update('\0').update(resource.digest).update('\0')
    }
    return hash.digest('hex')
  }
  return skill.digest ?? contentHash ?? null
}

function archiveRootDir(): string {
  return join(getClaudeConfigHomeDir(), CACHE_ROOT_DIR)
}

function safeSlugComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 64) || 'skill'
}

function slugForSkill(serverName: string, skill: DiskCacheSkill): string {
  const suffix = createHash('sha256')
    .update(`${serverName}\0${skill.resourceUri}`)
    .digest('hex')
    .slice(0, 8)
  const qualifiedPrefix = `${serverName}:`
  const skillName = skill.name.startsWith(qualifiedPrefix)
    ? skill.name.slice(qualifiedPrefix.length)
    : skill.name
  return `${safeSlugComponent(serverName)}--${safeSlugComponent(skillName)}--${suffix}`
}

function cachePaths(serverName: string, skill: DiskCacheSkill, cacheKey?: string) {
  const slugDir = join(archiveRootDir(), slugForSkill(serverName, skill))
  return {
    slugDir,
    metaPath: join(slugDir, META_FILENAME),
    keyDir: cacheKey ? join(slugDir, cacheKey) : undefined,
    skillPath: cacheKey ? join(slugDir, cacheKey, SKILL_FILENAME) : undefined,
  }
}

function isCacheKey(value: unknown): value is string {
  return typeof value === 'string' && CACHE_KEY_PATTERN.test(value)
}

function validMeta(value: unknown): DiskCacheMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!isCacheKey(candidate.cacheKey)) return null
  const declaredDigest = isCacheKey(candidate.declaredDigest)
    ? candidate.declaredDigest
    : undefined
  if (candidate.declaredDigest !== undefined && declaredDigest === undefined) {
    return null
  }
  if (
    typeof candidate.fetchedAt !== 'number' ||
    !Number.isFinite(candidate.fetchedAt)
  ) {
    return null
  }
  return {
    uri: typeof candidate.uri === 'string' ? candidate.uri : undefined,
    cacheKey: candidate.cacheKey,
    declaredDigest,
    fetchedAt: candidate.fetchedAt,
  }
}

async function readMeta(slugDir: string): Promise<DiskCacheMeta | null> {
  try {
    return validMeta(JSON.parse(await readFile(join(slugDir, META_FILENAME), 'utf8')))
  } catch {
    return null
  }
}

async function readCachedSkillMd(
  slugDir: string,
  cacheKey: string,
  contentDigest: string,
): Promise<McpSkillDiskCacheHit | null> {
  try {
    const skillPath = join(slugDir, cacheKey, SKILL_FILENAME)
    const fileStat = await stat(skillPath)
    if (!fileStat.isFile() || fileStat.size > MAX_MCP_SKILL_CONTENT_BYTES) {
      return null
    }
    const skillMd = await readFile(skillPath, 'utf8')
    if (
      Buffer.byteLength(skillMd, 'utf8') > MAX_MCP_SKILL_CONTENT_BYTES ||
      hashMcpSkillContent(skillMd) !== contentDigest
    ) {
      return null
    }
    return { cacheKey, skillMd }
  } catch {
    return null
  }
}

export async function readMcpSkillDiskCache(
  serverName: string,
  skill: DiskCacheSkill,
): Promise<McpSkillDiskCacheHit | null> {
  const { slugDir } = cachePaths(serverName, skill)
  const cacheKey = cacheKeyForSkill(skill)
  if (cacheKey && skill.digest) {
    return readCachedSkillMd(slugDir, cacheKey, skill.digest)
  }

  const meta = await readMeta(slugDir)
  if (
    !meta ||
    meta.uri !== skill.resourceUri ||
    meta.declaredDigest !== undefined ||
    Date.now() - meta.fetchedAt >= META_TTL_MS
  ) {
    return null
  }
  return readCachedSkillMd(slugDir, meta.cacheKey, meta.cacheKey)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

async function cachedSkillFileIsValid(
  skillPath: string,
  contentDigest: string,
) {
  try {
    const fileStat = await stat(skillPath)
    if (!fileStat.isFile() || fileStat.size > MAX_MCP_SKILL_CONTENT_BYTES) {
      return false
    }
    const skillMd = await readFile(skillPath, 'utf8')
    return (
      Buffer.byteLength(skillMd, 'utf8') <= MAX_MCP_SKILL_CONTENT_BYTES &&
      hashMcpSkillContent(skillMd) === contentDigest
    )
  } catch {
    return false
  }
}

async function writeSkillMd(
  slugDir: string,
  keyDir: string,
  skillPath: string,
  contentDigest: string,
  skillMd: string,
): Promise<void> {
  if (await cachedSkillFileIsValid(skillPath, contentDigest)) return

  const tmpDir = join(
    slugDir,
    `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  )
  await mkdir(tmpDir, { mode: 0o700 })
  try {
    await writeFile(join(tmpDir, SKILL_FILENAME), skillMd, { mode: 0o600 })
    await rename(tmpDir, keyDir)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeMeta(slugDir: string, meta: DiskCacheMeta): Promise<void> {
  const tmpMetaPath = join(
    slugDir,
    `.meta-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  )
  try {
    await writeFile(tmpMetaPath, JSON.stringify(meta), { mode: 0o600 })
    await rename(tmpMetaPath, join(slugDir, META_FILENAME))
  } finally {
    await rm(tmpMetaPath, { force: true }).catch(() => {})
  }
}

export async function writeMcpSkillDiskCache(
  serverName: string,
  skill: DiskCacheSkill,
  skillMd: string,
): Promise<void> {
  const contentHash = hashMcpSkillContent(skillMd)
  const cacheKey = cacheKeyForSkill(skill, contentHash)
  if (!cacheKey) return
  const { slugDir, keyDir, skillPath } = cachePaths(serverName, skill, cacheKey)
  if (!keyDir || !skillPath) return

  await mkdir(slugDir, { recursive: true, mode: 0o700 })
  await writeSkillMd(slugDir, keyDir, skillPath, contentHash, skillMd)
  await writeMeta(slugDir, {
    uri: skill.resourceUri,
    cacheKey,
    declaredDigest: skill.digest,
    fetchedAt: Date.now(),
  })
}
