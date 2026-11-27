import { FORK_GLYPH } from '../../constants/figures.js'
import type { JobRecord } from '../../daemon/protocol.js'

export type ForkRow = {
  id: string
  label: string
  status: 'running' | 'completed'
  when: string
}

/**
 * The `/tasks` Forks group, as in official 2.1.329: background sessions
 * forked from this one, running ones first, each labelled by the part of its
 * name after the last ⑂.
 */
export function forkRows(jobs: JobRecord[], sessionId: string): ForkRow[] {
  return jobs
    .filter(job => job.forkParentSessionId === sessionId)
    .map(job => ({
      id: job.id,
      label: job.name.split(FORK_GLYPH).at(-1)?.trim() || job.id,
      status: job.state === 'running' ? ('running' as const) : ('completed' as const),
      when: job.state === 'running' ? 'working' : job.state,
    }))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
}
