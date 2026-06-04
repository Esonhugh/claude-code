import React from 'react'

export function SnapshotUpdateDialog(_props: {
  agentType: string
  scope: unknown
  snapshotTimestamp: string
  onComplete: (result: 'replace' | 'merge' | 'keep') => void
  onCancel: () => void
}): React.ReactNode {
  return null
}

export function buildMergePrompt(_agentType?: string, _scope?: string): string {
  return ''
}
