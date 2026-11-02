import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export const COOKIE_NAME = 'claude_web'
const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function createWebSecrets(): { token: string; cookieKey: Buffer } {
  return {
    token: randomBytes(32).toString('base64url'),
    cookieKey: randomBytes(32),
  }
}

export function checkToken(expected: string, given: string | null): boolean {
  return given !== null && safeEqual(expected, given)
}

/** `<expiry>.<hmac>`; the key only lives in this process, so a restart logs browsers out. */
export function signCookie(key: Buffer, now = Date.now()): string {
  const expiry = String(Math.floor(now / 1000) + COOKIE_MAX_AGE_S)
  const mac = createHmac('sha256', key).update(expiry).digest('base64url')
  return `${expiry}.${mac}`
}

export function verifyCookie(
  key: Buffer,
  value: string | undefined,
  now = Date.now(),
): boolean {
  if (!value) return false
  const [expiry, mac, extra] = value.split('.')
  if (!expiry || !mac || extra !== undefined || !/^\d+$/.test(expiry)) {
    return false
  }
  const expected = createHmac('sha256', key).update(expiry).digest('base64url')
  return safeEqual(expected, mac) && Number(expiry) * 1000 > now
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim()
    }
  }
  return undefined
}

export function cookieHeader(value: string, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`
}

/** Host header values this server answers to (DNS rebinding guard). */
export function allowedHosts(port: number, trusted: string[] = []): Set<string> {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...trusted.map(host => (host.includes(':') ? host : `${host}:${port}`)),
  ])
}

/**
 * Rejects requests that did not come from this server's own page: wrong Host
 * (DNS rebinding), a foreign or `null` Origin, or `Sec-Fetch-Site: cross-site`.
 * Returns the reason, or undefined when the request is trusted.
 */
export function untrustedReason(
  req: Request,
  hosts: Set<string>,
  { requireOrigin }: { requireOrigin: boolean },
): string | undefined {
  const host = req.headers.get('host')
  if (!host || !hosts.has(host.toLowerCase())) return 'host'
  if (req.headers.get('sec-fetch-site') === 'cross-site') return 'cross-site'
  const origin = req.headers.get('origin')
  if (origin === null) return requireOrigin ? 'origin' : undefined
  let originHost: string
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'origin'
    originHost = url.host
  } catch {
    return 'origin'
  }
  return originHost.toLowerCase() === host.toLowerCase() ? undefined : 'origin'
}
