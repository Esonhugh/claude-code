// End-to-end check of the app on this machine, run by CI after staging the
// sidecar: `bun run e2e` (under xvfb-run on Linux). Exits 1 on the first failure.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

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

async function run() {
  const win = await until('the window', () => BrowserWindow.getAllWindows()[0], 60_000)
  const page = script => win.webContents.executeJavaScript(script)
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

  if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`)
  log('ok   no console errors')

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
