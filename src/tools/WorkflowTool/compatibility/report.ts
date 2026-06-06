import type { WorkflowCompatibilityDiff, WorkflowCompatibilityReport } from './types.js'

function differenceText(diff: WorkflowCompatibilityDiff): string {
  return diff.differences.length === 0 ? 'none' : diff.differences.join('; ')
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n')
}

export function renderEvidenceMatrixMarkdown(report: WorkflowCompatibilityReport): string {
  const lines = [
    '# Workflow Compatibility Evidence Matrix',
    '',
    `Generated: ${report.generatedAt}`,
    `Official binary: ${report.officialBinary}`,
    `Score: ${report.score}`,
    '',
    '| Case | Status | Severity | Confidence | Reruns | Same Points | Differences | Official Command | Local Command | Official Artifacts | Local Artifacts |',
    '| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |',
  ]

  for (const diff of report.diffs) {
    lines.push(
      `| ${diff.caseId} | ${diff.status} | ${diff.severity} | ${diff.confidence} | ${diff.rerunCount} | ${tableCell(diff.samePoints.join('; ') || 'none')} | ${tableCell(differenceText(diff))} | ${tableCell(diff.officialArtifacts.command.join(' '))} | ${tableCell(diff.localArtifacts.command.join(' '))} | ${tableCell(diff.officialArtifacts.workspacePath)} | ${tableCell(diff.localArtifacts.workspacePath)} |`,
    )
  }

  return `${lines.join('\n')}\n`
}

export function renderDevelopmentGuideMarkdown(report: WorkflowCompatibilityReport): string {
  const byArea = new Map<string, WorkflowCompatibilityDiff[]>()
  for (const diff of report.diffs) {
    for (const area of diff.likelySourceAreas.length === 0 ? ['no-change-needed'] : diff.likelySourceAreas) {
      const diffs = byArea.get(area) ?? []
      diffs.push(diff)
      byArea.set(area, diffs)
    }
  }

  const lines = [
    '# Workflow Compatibility Development Guide',
    '',
    `Generated: ${report.generatedAt}`,
    `Compatibility score: ${report.score}`,
    '',
  ]

  for (const [area, diffs] of [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${area}`, '')
    for (const diff of diffs) {
      lines.push(`- ${diff.caseId} (${diff.severity}, ${diff.confidence}): ${differenceText(diff)}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
