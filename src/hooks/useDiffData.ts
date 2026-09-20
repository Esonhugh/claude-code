import type { StructuredPatchHunk } from 'diff'
import { useEffect, useSyncExternalStore } from 'react'
import type { DiffController } from '../services/diff/controller.js'
import type { GitDiffStats } from '../utils/gitDiff.js'

export type DiffFile = {
  path: string
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isLargeFile: boolean
  isTruncated: boolean
  isNewFile?: boolean
  isUntracked?: boolean
  isPreSession?: boolean
  isNoise?: boolean
  bodyState?:
    | 'loading'
    | 'ready'
    | 'unavailable'
    | 'binary'
    | 'no-body'
    | 'large'
    | 'truncated'
}

export type DiffData = {
  stats: GitDiffStats | null
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
  outcome?: 'data' | 'unavailable' | 'no-repository'
  baseLabel?: string
  error?: string
  isUntrackedWithheld?: boolean
  isUnborn?: boolean
}

export function useDiffData(controller: DiffController): DiffData {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  )
  useEffect(() => controller.watch(), [controller])
  return state.data
}
