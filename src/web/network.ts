import { isIPv4, isIPv6 } from 'net'
import { hostname, networkInterfaces } from 'os'

export type AddressKind = 'loopback' | 'lan' | 'other'

function ipv4Kind(ip: string): AddressKind {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  if (a === 127) return 'loopback'
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return 'lan'
  }
  return 'other'
}

/** Expands an IPv6 address (zone id dropped) into eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.split('%')[0]!
  const lastColon = text.lastIndexOf(':')
  const dotted = text.slice(lastColon + 1)
  if (isIPv4(dotted)) {
    const [a, b, c, d] = dotted.split('.').map(Number) as number[]
    const hex = (n: number) => n.toString(16)
    text = `${text.slice(0, lastColon + 1)}${hex((a! << 8) | b!)}:${hex((c! << 8) | d!)}`
  }
  const [head, rest] = text.split('::') as [string, string | undefined]
  const parse = (part: string) =>
    part ? part.split(':').map(group => parseInt(group, 16)) : []
  const left = parse(head)
  const right = parse(rest ?? '')
  const missing = 8 - left.length - right.length
  if (missing < 0 || (rest === undefined && missing !== 0)) return undefined
  return [...left, ...Array<number>(missing).fill(0), ...right]
}

/**
 * Classifies a peer or bind address. `lan` covers RFC 1918, link-local
 * (169.254/16, fe80::/10), CGNAT 100.64/10 (Tailscale) and ULA fc00::/7;
 * IPv4-mapped IPv6 addresses are classified by their IPv4 part.
 */
export function addressKind(address: string): AddressKind {
  const ip = address.startsWith('[') ? address.slice(1, -1) : address
  if (isIPv4(ip)) return ipv4Kind(ip)
  if (!isIPv6(ip.split('%')[0]!)) return 'other'
  const groups = ipv6Groups(ip)
  if (!groups) return 'other'
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!]
    return ipv4Kind(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) {
    return 'loopback'
  }
  const first = groups[0]!
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00) return 'lan'
  return 'other'
}

/** Whether a connection from this peer address may be served at all. */
export function isAllowedPeer(address: string | undefined): boolean {
  return address !== undefined && addressKind(address) !== 'other'
}

/** Non-loopback addresses of this machine's interfaces that count as LAN. */
export function lanInterfaceAddresses(): string[] {
  const out: string[] = []
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      const address = info.address.split('%')[0]!
      if (!info.internal && addressKind(address) === 'lan') out.push(address)
    }
  }
  return out
}

/** Host header names (without port) a LAN browser may use for this machine. */
export function lanHostNames(): string[] {
  const name = hostname().toLowerCase().split('.')[0]
  return [
    ...lanInterfaceAddresses().map(a => (a.includes(':') ? `[${a}]` : a)),
    ...(name ? [`${name}.local`] : []),
  ]
}

/**
 * Picks the bind address for `claude web`. `--host` wins over the flag's
 * wildcard, but only loopback or LAN addresses are accepted, and a LAN one
 * needs `--dangerously-allow-local-network`.
 */
export function resolveBindHost(
  host: string | undefined,
  allowLocalNetwork: boolean,
): { host: string } | { error: string } {
  if (host === undefined) {
    return { host: allowLocalNetwork ? '0.0.0.0' : '127.0.0.1' }
  }
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  const kind = bare === 'localhost' ? 'loopback' : addressKind(bare)
  if (kind === 'loopback') return { host: bare }
  if (kind === 'lan') {
    return allowLocalNetwork
      ? { host: bare }
      : {
          error: `--host ${host} is a local network address; pass --dangerously-allow-local-network to bind it.`,
        }
  }
  return {
    error: `--host must be a loopback or local network address (got ${host}).`,
  }
}
