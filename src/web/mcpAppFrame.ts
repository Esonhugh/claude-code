/**
 * The page an MCP App (a `ui://` resource, SEP-1865) runs under. Its CSP
 * sandboxes it to an opaque origin, so the app cannot reach the web API, and
 * lets it run inline code and reach https hosts; the page then narrows that
 * with a `<meta>` CSP built from the resource's own `_meta.ui.csp`. The
 * bootstrap takes the app's HTML once from the parent and writes it in; the
 * app then talks JSON-RPC to the parent over postMessage.
 */
export const MCP_APP_FRAME_PATH = '/mcp-app-frame'

export const MCP_APP_FRAME_HTML = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function load(e) {
  if (e.source !== parent || !e.data || e.data.type !== 'claude-mcp-app' || typeof e.data.html !== 'string') return
  removeEventListener('message', load)
  document.open()
  document.write(e.data.html)
  document.close()
})
parent.postMessage({ type: 'claude-mcp-app-ready' }, '*')
</script>`

export const MCP_APP_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  'connect-src https: wss:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ')
