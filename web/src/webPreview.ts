import { createContext } from 'react'

/** Where the page runs and which extra origins `--preview-origin` allows. */
export type PreviewEnv = {
  uiOrigin: string
  origins: readonly string[]
}

// Exactly the loopback hosts the server's CSP lets the page frame. CSP host
// sources cannot name IPv6 literals, so `[::1]` only counts for the UI itself.
const FRAMEABLE_LOOPBACK = new Set(['localhost', '127.0.0.1'])

function isLoopbackHost(hostname: string): boolean {
  return FRAMEABLE_LOOPBACK.has(hostname) || hostname === '[::1]'
}

function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80')
}

/**
 * The URL to show in the web preview frame, or undefined when `href` may not
 * be framed: not http(s), carrying credentials, this UI itself under any of
 * its names (the frame has allow-same-origin, so it could script the page),
 * loopback while the page was opened from another device (localhost would
 * be that device), or an origin nobody allowed with `--preview-origin`.
 */
export function previewTarget(href: string, env: PreviewEnv): string | undefined {
  let url: URL
  let ui: URL
  try {
    url = new URL(href)
    ui = new URL(env.uiOrigin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  const loopback = FRAMEABLE_LOOPBACK.has(url.hostname)
  const uiLoopback = isLoopbackHost(ui.hostname)
  if (
    url.origin === ui.origin ||
    (portOf(url) === portOf(ui) &&
      (url.hostname === ui.hostname || (loopback && uiLoopback)))
  ) {
    return undefined
  }
  if (loopback) return uiLoopback ? url.href : undefined
  return env.origins.includes(url.origin) ? url.href : undefined
}

/** The first URL in tool output that `target` accepts. */
export function firstPreviewUrl(
  text: string,
  target: (href: string) => string | undefined,
): string | undefined {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = target(match[0].replace(/[.,;:!?)]+$/, ''))
    if (url) return url
  }
  return undefined
}

/** Lets messages offer "Preview" next to links the web preview can frame. */
export const WebPreviewContext = createContext<{
  target?: (href: string) => string | undefined
  open?: (url: string) => void
  label?: string
}>({})
