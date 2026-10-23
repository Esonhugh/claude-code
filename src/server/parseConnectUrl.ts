import { DirectConnectError } from './createDirectConnectSession.js'

export type ParsedConnectUrl = {
  serverUrl: string
  authToken?: string
}

/**
 * Parse a direct-connect URL.
 *
 * `cc://host:port/<token>` → `{ serverUrl: 'http://host:port', authToken }`.
 * An optional `?serverUrl=http(s)://...` overrides the HTTP base URL (e.g. a
 * TLS-terminating proxy) while the token still comes from the path.
 */
export function parseConnectUrl(url: string): ParsedConnectUrl {
  if (url.startsWith('cc+unix://')) {
    throw new DirectConnectError(
      'Unix socket connect (cc+unix://) is not supported',
    )
  }
  if (!url.startsWith('cc://')) {
    throw new DirectConnectError(
      'Invalid connect URL: expected cc://host:port/<token>',
    )
  }

  // Error messages never echo the URL: its path is the auth token.
  let parsed: URL
  let pathToken: string
  try {
    parsed = new URL(`http://${url.slice('cc://'.length)}`)
    pathToken = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    throw new DirectConnectError('Invalid connect URL')
  }
  if (!parsed.hostname) {
    throw new DirectConnectError('Invalid connect URL: missing host')
  }
  const authToken = pathToken || parsed.searchParams.get('token') || undefined

  const override = parsed.searchParams.get('serverUrl')
  if (!override) {
    return { serverUrl: `http://${parsed.host}`, authToken }
  }

  let overrideUrl: URL
  try {
    overrideUrl = new URL(override)
  } catch {
    throw new DirectConnectError(`Invalid serverUrl: ${override}`)
  }
  if (overrideUrl.protocol !== 'http:' && overrideUrl.protocol !== 'https:') {
    throw new DirectConnectError(
      `Invalid serverUrl: ${override} (must be http:// or https://)`,
    )
  }
  return {
    serverUrl: `${overrideUrl.origin}${overrideUrl.pathname}`.replace(/\/+$/, ''),
    authToken,
  }
}
