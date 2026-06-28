export function formatToolResultMessage(
  output: Record<string, unknown>,
): string | null {
  if ('error' in output) {
    const error = output.error as { code?: string; message?: string }
    return `${error.code ?? 'ERROR'}: ${error.message ?? 'unknown error'}`
  }

  if ('sessionId' in output && output.mode === 'save_file') {
    const preview = typeof output.preview === 'string' ? output.preview : ''
    return `read ${String(output.sessionId)} saved to ${String(
      output.filePath,
    )}\npreview:\n${preview}`
  }

  if ('sessionId' in output && 'text' in output) {
    const mode = typeof output.mode === 'string' ? output.mode : 'full'
    return `read ${String(output.sessionId)} (${mode})\n${String(output.text)}`
  }

  return null
}
