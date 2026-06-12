import { normalizeTerminalPreview } from './previewText.ts'

const MAX_PREVIEW_LINES = 24

export function mergePreviewWindow(
  existing: string,
  incoming: string,
): string {
  const merged = normalizeTerminalPreview(
    existing ? `${existing}\n${incoming}` : incoming,
  )
  const lines = merged.split('\n')
  return lines.slice(-MAX_PREVIEW_LINES).join('\n')
}
