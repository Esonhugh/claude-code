import { normalizeTerminalPreview } from './previewText.js'

const MAX_PREVIEW_LINES = 24

export function mergePreviewWindow(
  existing: string,
  incoming: string,
): string {
  const combined = !existing
    ? incoming
    : incoming.startsWith('\r')
      ? `${existing}${incoming}`
      : `${existing}\n${incoming}`
  const merged = normalizeTerminalPreview(combined)
  const lines = merged.split('\n')
  return lines.slice(-MAX_PREVIEW_LINES).join('\n')
}
