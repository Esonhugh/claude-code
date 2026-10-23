import type { ServerConfig } from './types.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Startup banner on stdout: where the server listens and how to connect. */
export function printBanner(
  config: ServerConfig,
  authToken: string,
  port: number,
): void {
  const lines: string[] = []
  if (config.unix) {
    lines.push(
      `Claude Code server listening on unix socket ${config.unix}`,
      'Note: cc+unix:// connect URLs are not supported by the client; use --port to serve over TCP.',
    )
  } else {
    const wildcard = config.host === '0.0.0.0' || config.host === '::'
    const host = wildcard ? '127.0.0.1' : config.host
    const urlHost = host.includes(':') ? `[${host}]` : host
    lines.push(
      `Claude Code server listening on http://${urlHost}:${port}`,
      `Connect with: claude cc://${urlHost}:${port}/${encodeURIComponent(authToken)}`,
    )
    if (!LOOPBACK_HOSTS.has(config.host)) {
      lines.push(
        `Warning: bound to ${config.host}, reachable from other machines over unencrypted HTTP. Anyone with the token can run commands as you.`,
      )
    }
  }
  lines.push(
    'Sessions run with your local credentials and full access to this machine. Press Ctrl+C to stop.',
  )
  process.stdout.write(lines.join('\n') + '\n')
}
