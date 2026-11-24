// End-to-end check of the app on this machine, run by CI after staging the
// sidecar: `bun run e2e` (under xvfb-run on Linux). Exits 1 on the first failure.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'

const home = mkdtempSync(join(tmpdir(), 'claude-desktop-e2e-'))
process.env.CLAUDE_CONFIG_DIR = join(home, 'config')
app.setPath('userData', join(home, 'electron'))

const serverLog = []
const log = console.log
console.log = (...args) => {
  serverLog.push(args.join(' '))
  log(...args)
}
const consoleErrors = []
// The app reports a sidecar that will not start in a modal box, which would
// block this run (and its timeout) until the job is killed.
dialog.showErrorBox = (_title, message) => {
  log(`FAIL ${message}`)
  app.exit(1)
}
// Links and sign-in pages the app hands to the browser, recorded instead.
const opened = []
shell.openExternal = async url => {
  opened.push(url)
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => {
    if (event.level === 'error') consoleErrors.push(event.message)
  })
})

await import('./main.js')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(what, check, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(250)) {
    const value = await check()
    if (value) return value
  }
  throw new Error(`timed out waiting for ${what}`)
}
function finish(code) {
  app.once('quit', () => {
    // The sidecar has stopped by now; Windows may still hold a file for a moment.
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
    app.exit(code)
  })
  app.quit()
}
setTimeout(() => {
  log('FAIL timed out')
  app.exit(1)
}, 180_000).unref()

// Posts to the app's API the ways a previewed site could; the server must refuse both.
const HOSTILE_PAGE = `<iframe name="sink"></iframe><script>
fetch('claude-app://app/api/sessions', { method: 'POST', mode: 'no-cors', body: '{"temporary":true}' })
const form = Object.assign(document.createElement('form'), { method: 'POST', action: 'claude-app://app/api/sessions', enctype: 'text/plain', target: 'sink' })
form.appendChild(Object.assign(document.createElement('input'), { name: '{"temporary":true,"x":"', value: '"}' }))
document.body.appendChild(form)
form.submit()
</script>`

// A Mod Client with a stand-in surface runtime: it draws one string from its Worker.
const MOD_BUNDLE = {
  files: [
    {
      key: 'claude:surface-runtime',
      source: `export const h = () => null
export const Fragment = null
export function install() {
  let draw
  globalThis.__surface__ = { run: () => JSON.stringify({ text: draw() }) }
  return { mount(_id, d) { draw = d }, resize() {}, stage() {}, dropHeld() {}, unmount() {}, setProps() {} }
}`,
    },
    { key: 'surface:///panel.js', source: `export function Panel() { return 'drawn in a Worker' }` },
  ],
  modules: [{ module: 'panel', entry: 'surface:///panel.js', component: 'Panel' }],
  limits: {},
}
const MOD_CLIENT = `new Promise(resolve => {
  const frame = Object.assign(document.createElement('iframe'), { src: '/mods-frame', hidden: true })
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.onload = () => {
    const channel = new MessageChannel()
    channel.port1.onmessage = e => {
      if (e.data.op !== 'tree' && e.data.op !== 'fault') return
      frame.remove()
      resolve(e.data)
    }
    frame.contentWindow.postMessage('claude-mods-frame', '*', [channel.port2])
    channel.port1.postMessage({ op: 'load', bundle: ${JSON.stringify(MOD_BUNDLE)} })
    channel.port1.postMessage({ op: 'mount', id: 1, module: 'panel', props: {}, columns: 80, rows: 24 })
  }
  document.body.appendChild(frame)
  setTimeout(() => resolve({ op: 'timeout' }), 20000)
})`

// Runs an MCP App's HTML in its frame the way McpApp.tsx does; the app reports with `parent.postMessage({ type: 'e2e', ... })`.
const mcpApp = html => `new Promise(resolve => {
  const frame = Object.assign(document.createElement('iframe'), { src: '/mcp-app-frame', hidden: true })
  frame.setAttribute('sandbox', 'allow-scripts allow-forms')
  addEventListener('message', function listen(e) {
    if (e.source !== frame.contentWindow || !e.data) return
    if (e.data.type === 'claude-mcp-app-ready') frame.contentWindow.postMessage({ type: 'claude-mcp-app', html: ${JSON.stringify(html)} }, '*')
    if (e.data.type !== 'e2e') return
    removeEventListener('message', listen)
    frame.remove()
    resolve(e.data)
  })
  document.body.appendChild(frame)
  setTimeout(() => resolve({ type: 'timeout' }), 20000)
})`
const MCP_APP = `<p id="text">hello</p><script>
parent.postMessage({ type: 'e2e', origin, text: document.getElementById('text').textContent }, '*')
</script>`
const HOSTILE_MCP_APP = `<script>
Promise.all([
  fetch('claude-app://app/api/account').then(res => 'reached ' + res.status, () => 'blocked'),
  new Promise(resolve => { try { resolve('reached ' + parent.location.href) } catch { resolve('blocked') } }),
  typeof window.claudeDesktop === 'undefined' ? 'blocked' : 'reached',
]).then(results => parent.postMessage({ type: 'e2e', results }, '*'))
</script>`

// The sign-in in Account.tsx: a blank tab opened on the click, pointed at the provider afterwards.
const SIGN_IN = `(async () => {
  const tab = window.open('', '_blank')
  const res = await fetch('/api/account/oauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"provider":"anthropic"}' })
  const body = await res.json()
  if (tab) {
    tab.opener = null
    tab.location.href = body.url
  }
  return { status: res.status, body, tab: Boolean(tab) }
})()`

async function run() {
  const win = await until('the window', () => BrowserWindow.getAllWindows()[0], 60_000)
  const page = (script, gesture = false) => win.webContents.executeJavaScript(script, gesture)
  await until('the page to render', () => page('document.getElementById("root")?.childElementCount > 0'))
  log('ok   page rendered')
  if ((await page('typeof window.claudeDesktop?.socket')) !== 'function') throw new Error('no window.claudeDesktop bridge')

  const created = await page(`fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"temporary":true}' })
    .then(async res => ({ status: res.status, body: await res.json() }))`)
  if (created.status !== 200) throw new Error(`POST /api/sessions: ${created.status} ${JSON.stringify(created.body)}`)
  log('ok   page can create a session')

  const events = await page(`new Promise(resolve => {
    const seen = []
    const socket = window.claudeDesktop.socket('/api/sessions/${created.body.session_id}/ws', (type, _data, code) => {
      seen.push(type === 'close' ? 'close ' + code : type)
      if (type === 'open') socket.close(1000, 'e2e')
      if (type === 'close') resolve(seen)
    })
    setTimeout(() => resolve(seen), 20000)
  })`)
  if (events[0] !== 'open' || events.at(-1) !== 'close 1000') throw new Error(`session socket: ${events.join(', ')}`)
  log('ok   session socket opens and closes')

  const saved = () => JSON.parse(readFileSync(join(home, 'electron', 'appearance.json'), 'utf8')).theme
  await page(`window.claudeDesktop.setTheme('dark')`)
  await until('the window to turn dark', () => nativeTheme.themeSource === 'dark' && nativeTheme.shouldUseDarkColors)
  if (saved() !== 'dark') throw new Error(`saved appearance: ${saved()}`)
  await page(`window.claudeDesktop.setTheme('auto'), window.claudeDesktop.setTheme('system')`)
  await until('the window to follow the system', () => nativeTheme.themeSource === 'system')
  if (saved() !== 'system') throw new Error(`saved appearance: ${saved()}`)
  log('ok   the page sets and saves the native theme')

  const mod = await page(MOD_CLIENT)
  if (mod.op !== 'tree' || mod.text !== JSON.stringify({ text: 'drawn in a Worker' })) throw new Error(`mods frame: ${JSON.stringify(mod)}`)
  log('ok   mods frame runs a Client in its Worker')

  const shown = await page(mcpApp(MCP_APP))
  if (shown.text !== 'hello' || shown.origin !== 'null') throw new Error(`MCP App frame: ${JSON.stringify(shown)}`)
  log('ok   MCP App frame runs the app at an opaque origin')

  if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`)
  log('ok   no console errors')

  const handedOff = async (what, url) => {
    await until(`${what} to open in the browser`, () => opened.includes(url), 10_000)
    await until(`${what} to leave no window behind`, () => BrowserWindow.getAllWindows().length === 1, 10_000)
  }
  const signIn = await page(SIGN_IN, true)
  if (signIn.status !== 200 || !signIn.tab || !/^https:\/\//.test(signIn.body.url)) throw new Error(`sign-in: ${JSON.stringify(signIn)}`)
  await handedOff('the sign-in page', signIn.body.url)
  const post = (path, body, method = 'POST') =>
    page(`fetch('${path}', { method: '${method}', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} }).then(res => res.status)`)
  const statuses = [
    await post('/api/account/oauth/code', '{"code":"no-state"}'),
    await post('/api/account/oauth', '', 'DELETE'),
    await post('/api/account/oauth/code', '{"code":"a#b"}'),
  ]
  if (statuses.join() !== '400,204,409') throw new Error(`sign-in code and cancel: ${statuses.join()}`)
  log('ok   sign-in opens in the browser; a bad code and cancel are handled')

  await page(`window.open('about:blank', '_blank').location.href = 'https://example.com/mcp-auth', 0`, true)
  await handedOff('an MCP server sign-in', 'https://example.com/mcp-auth')
  await page(`window.open('https://example.com/link', '_blank', 'noopener,noreferrer'), 0`, true)
  await handedOff('a link from an MCP App', 'https://example.com/link')
  log('ok   MCP sign-in and links open in the browser')

  const probed = await page(mcpApp(HOSTILE_MCP_APP))
  if (probed.results?.join() !== 'blocked,blocked,blocked') throw new Error(`MCP App reached the app: ${JSON.stringify(probed)}`)
  log('ok   MCP App cannot reach the app API, the page or the bridge')

  const hostile = createServer((_req, res) => res.setHeader('content-type', 'text/html').end(HOSTILE_PAGE))
  await new Promise(resolve => hostile.listen(0, '127.0.0.1', resolve))
  const before = serverLog.filter(line => line.includes('rejected POST /api/sessions')).length
  await page(`document.body.appendChild(Object.assign(document.createElement('iframe'), { src: 'http://127.0.0.1:${hostile.address().port}/' })), 0`)
  await until('the hostile posts to be refused', () =>
    serverLog.filter(line => line.includes('rejected POST /api/sessions')).length - before >= 2,
  )
  hostile.close()
  log('ok   posts from a previewed site are refused')
}

app.whenReady().then(() =>
  run().then(
    () => finish(0),
    err => {
      log(`FAIL ${err.message}`)
      finish(1)
    },
  ),
)
