/**
 * Peer address parsing — kept separate from peerRegistry.ts so that
 * SendMessageTool can import parseAddress without transitively loading
 * the bridge (axios) and UDS (fs, net) modules at tool-enumeration time.
 */

/** Parse a URI-style address into scheme + target. */
export function parseAddress(to: string): {
  scheme: 'uds' | 'bridge' | 'other'
  target: string
} {
  if (to.startsWith('uds:') || to.startsWith('bridge:')) {
    const scheme = to.startsWith('uds:') ? 'uds' : 'bridge'
    const encoded = to.slice(scheme.length + 1)
    let target = encoded
    try {
      target = decodeURIComponent(encoded)
    } catch {
      // Official senders preserve malformed percent escapes literally.
    }
    return { scheme, target }
  }
  if (/^\/\S*\.sock$/.test(to) || /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(to)) {
    return { scheme: 'uds', target: to }
  }
  return { scheme: 'other', target: to }
}
