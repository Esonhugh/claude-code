// Links in model output may only leave the page as http(s) or mailto, and
// images may only come from inline data or this server's file API.

export function safeLinkHref(url: string): string | undefined {
  try {
    const parsed = new URL(url, 'http://invalid.local/')
    if (parsed.origin === 'http://invalid.local') return undefined
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
      ? url
      : undefined
  } catch {
    return undefined
  }
}

export function safeImageSrc(url: string): string | undefined {
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url)) {
    return url
  }
  return url.startsWith('/api/files/') && !url.includes('..') ? url : undefined
}

/**
 * A local absolute path in model output (`/tmp/a.png`, `file:///…`, `C:\\…`)
 * becomes a URL on this server's file API for the session at `filesBase`.
 */
export function localFileSrc(url: string, filesBase: string | undefined): string {
  if (!filesBase) return url
  let path: string | undefined
  if (url.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(url).pathname)
    } catch {
      return url
    }
  } else if (/^\/(?!\/|api\/)/.test(url) || /^[A-Za-z]:[\\/]/.test(url)) {
    path = url
  }
  return path ? `${filesBase}?path=${encodeURIComponent(path)}` : url
}
