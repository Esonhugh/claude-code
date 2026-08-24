export const PROMPT_LAYER_ORDER = [
  'stable-core',
  'capability',
  'task-dynamic',
] as const

export type PromptLayer = (typeof PROMPT_LAYER_ORDER)[number]

export type PromptSectionRelation =
  | 'owner'
  | 'override-default'
  | 'reinforce'

export type PromptSection = {
  id: string
  layer: PromptLayer
  content: string | null
  relation?: PromptSectionRelation
}

export type ResolvedPromptSection = {
  id: string
  layer: PromptLayer
  content: string
}

type NormalizedPromptSection = {
  id: string
  layer: PromptLayer
  content: string
  relation: PromptSectionRelation
}

export function resolvePromptSections(
  sections: readonly PromptSection[],
): ResolvedPromptSection[] {
  const candidates: NormalizedPromptSection[] = []
  const candidatesById = new Map<string, NormalizedPromptSection[]>()

  for (const layer of PROMPT_LAYER_ORDER) {
    for (const section of sections) {
      if (section.layer !== layer || section.content === null) continue

      const candidate = {
        id: section.id,
        layer,
        content: section.content,
        relation: section.relation ?? 'owner',
      }
      candidates.push(candidate)
      const idCandidates = candidatesById.get(candidate.id) ?? []
      idCandidates.push(candidate)
      candidatesById.set(candidate.id, idCandidates)
    }
  }

  const selectedById = new Map<string, NormalizedPromptSection>()
  for (const [id, idCandidates] of candidatesById) {
    const override = idCandidates.findLast(
      candidate => candidate.relation === 'override-default',
    )
    if (override) {
      selectedById.set(id, override)
      continue
    }

    const [owner] = idCandidates
    if (!owner) continue
    if (idCandidates.some(candidate => candidate.content !== owner.content)) {
      throw new Error(
        `Prompt section "${id}" has conflicting content across layers`,
      )
    }
    selectedById.set(id, owner)
  }

  const seenContent = new Set<string>()
  const resolved: ResolvedPromptSection[] = []

  for (const candidate of candidates) {
    if (selectedById.get(candidate.id) !== candidate) continue
    if (candidate.relation !== 'reinforce' && seenContent.has(candidate.content)) {
      continue
    }

    seenContent.add(candidate.content)
    resolved.push({
      id: candidate.id,
      layer: candidate.layer,
      content: candidate.content,
    })
  }

  return resolved
}
