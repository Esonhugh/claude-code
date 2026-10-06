import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { z } from 'zod/v4'
import type { AgentId } from '../types/ids.js'
import { getAgentTranscriptPath } from './sessionStorage.js'

const MAX_SCOPE_BYTES = 524288
const identity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/.test(value))
const scopeSchema = z.object({
  skillName: identity,
  attributionName: identity,
  effort: z
    .union([
      z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
      z.number().int().min(1).max(1000),
    ])
    .optional(),
  frozenCommandDenies: z.array(z.string().max(1024)).max(1000).optional(),
})
const markerSchema = z.object({
  forkedSkill: z.literal(true),
  skillName: identity.optional(),
})
export type ForkedSkillScope = z.infer<typeof scopeSchema>
export type ForkedSkillScopeRead =
  | { status: 'valid'; scoping: ForkedSkillScope }
  | { status: 'absent' | 'absent-but-marked' | 'malformed' }

function scopePath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(
    /\.jsonl$/,
    '.forked-skill.json',
  )
}
function markerPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(
    /\.jsonl$/,
    '.forked-skill.marker.json',
  )
}
async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: 'wx',
    })
    await fs.rename(temporary, path)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

/** Marker first: a partial write must never allow an unscoped cold resume. */
export async function persistForkedSkillScope(
  agentId: AgentId,
  value: unknown,
): Promise<void> {
  const scope = scopeSchema.parse(value)
  await fs.mkdir(dirname(scopePath(agentId)), { recursive: true })
  await atomicWrite(markerPath(agentId), {
    forkedSkill: true,
    skillName: scope.skillName,
  })
  await atomicWrite(scopePath(agentId), scope)
}

type ReadResult =
  | { status: 'value'; value: unknown }
  | { status: 'absent' }
  | { status: 'malformed' }
async function readRecord(path: string): Promise<ReadResult> {
  try {
    // Reject symlinks, directories and overlarge records before reading JSON.
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.size > MAX_SCOPE_BYTES)
      return { status: 'malformed' }
    return {
      status: 'value',
      value: JSON.parse(await fs.readFile(path, 'utf8')),
    }
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'absent'
          : 'malformed',
    }
  }
}
export async function readForkedSkillScope(
  agentId: AgentId,
): Promise<ForkedSkillScopeRead> {
  const record = await readRecord(scopePath(agentId))
  if (record.status === 'absent') {
    return {
      status:
        (await readRecord(markerPath(agentId))).status === 'absent'
          ? 'absent'
          : 'absent-but-marked',
    }
  }
  if (record.status === 'malformed') return record
  const parsed = scopeSchema.safeParse(record.value)
  return parsed.success
    ? { status: 'valid', scoping: parsed.data }
    : { status: 'malformed' }
}
export async function readForkedSkillWitness(
  agentId: AgentId,
): Promise<string | undefined> {
  const record = await readRecord(markerPath(agentId))
  if (record.status !== 'value') return undefined
  const parsed = markerSchema.safeParse(record.value)
  return parsed.success ? parsed.data.skillName : undefined
}
