export function formatToolResultMessage(
  output: Record<string, unknown>,
): string | null {
  if ('error' in output) {
    const error = output.error as { code?: string; message?: string }
    return `${error.code ?? 'ERROR'}: ${error.message ?? 'unknown error'}`
  }

  if ('sessionId' in output && 'text' in output) {
    return `read ${String(output.sessionId)} → ${String(output.text)}`
  }

  return null
}
