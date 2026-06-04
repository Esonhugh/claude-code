export function startServer(
  config: { port: number; host: string; [key: string]: unknown },
  _sessionManager: unknown,
  _logger: unknown,
): { port?: number; stop: (force?: boolean) => void } {
  return { port: config.port, stop: () => {} }
}
