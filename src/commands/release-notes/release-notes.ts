import type { LocalCommandResult } from '../../types/command.js'
import { getAllReleaseNotes } from '../../utils/releaseNotes.js'

function formatReleaseNotes(notes: Array<[string, string[]]>): string {
  return notes
    .map(([version, notes]) => {
      const header = `Version ${version}:`
      const bulletPoints = notes.map(note => `· ${note}`).join('\n')
      return `${header}\n${bulletPoints}`
    })
    .join('\n\n')
}

export async function call(): Promise<LocalCommandResult> {
  const notes = getAllReleaseNotes()
  if (notes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(notes) }
  }

  return {
    type: 'text',
    value: 'No release notes are included in this build.',
  }
}
