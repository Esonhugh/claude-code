import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell } from 'electron'
import { startSidecar } from './sidecar.js'
import { isThemeMode, readThemeMode, writeThemeMode } from './theme.js'

const SCHEME = 'claude-app'
const APP_ORIGIN = `${SCHEME}://app`
const APP_URL = `${APP_ORIGIN}/`
const ENV_MARKER = '__CLAUDE_DESKTOP_ENV__'

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
])

/** The packaged `claude` binary, or `CLAUDE_DESKTOP_SIDECAR` (e.g. the repo's ./built-claude). */
function sidecarCommand() {
  if (process.env.CLAUDE_DESKTOP_SIDECAR) return process.env.CLAUDE_DESKTOP_SIDECAR
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  return join(app.isPackaged ? process.resourcesPath : import.meta.dirname, 'sidecar', name)
}

/**
 * An app opened from the Dock or a desktop menu does not get the login shell's
 * PATH and exports, which sessions' Bash and API key settings rely on.
 */
async function loginShellEnv() {
  if (process.platform === 'win32') return process.env
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  try {
    const { stdout } = await promisify(execFile)(shell, ['-ilc', `printf '${ENV_MARKER}'; env -0`], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const env = {}
    for (const entry of stdout.slice(stdout.indexOf(ENV_MARKER) + ENV_MARKER.length).split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return { ...process.env, ...env }
  } catch (err) {
    console.warn(`could not read the login shell environment: ${err.message}`)
    return process.env
  }
}

const isHttp = url => url.startsWith('http://') || url.startsWith('https://')
const isAppUrl = url => url === APP_ORIGIN || url.startsWith(APP_URL)

let sidecar
let stopped = false
// Session sockets by `<webContents id>:<page's socket number>`.
const sockets = new Map()

function closeSockets(contentsId) {
  for (const [key, channel] of sockets) {
    if (!key.startsWith(`${contentsId}:`)) continue
    sockets.delete(key)
    channel.close(1001, 'Page closed')
  }
}

function fromAppPage(event) {
  return event.senderFrame === event.sender.mainFrame && isAppUrl(event.senderFrame.url)
}

ipcMain.on('socket:open', (event, n, path) => {
  if (!fromAppPage(event) || typeof path !== 'string' || !path.startsWith('/api/')) return
  const contents = event.sender
  const key = `${contents.id}:${n}`
  const channel = sidecar.socket(path, (type, data, code, reason) => {
    if (type === 'close') sockets.delete(key)
    if (!contents.isDestroyed()) contents.send('socket:event', n, type, data, code, reason)
  })
  sockets.set(key, channel)
})
ipcMain.on('socket:send', (event, n, data) => {
  if (fromAppPage(event)) sockets.get(`${event.sender.id}:${n}`)?.send(String(data))
})
ipcMain.on('socket:close', (event, n, code, reason) => {
  if (fromAppPage(event)) sockets.get(`${event.sender.id}:${n}`)?.close(code, reason)
})

// The page's appearance setting, so native menus, dialogs and the title bar follow it.
const themeFile = () => join(app.getPath('userData'), 'appearance.json')
ipcMain.on('theme:set', (event, mode) => {
  if (!fromAppPage(event) || !isThemeMode(mode) || nativeTheme.themeSource === mode) return
  nativeTheme.themeSource = mode
  try {
    writeThemeMode(themeFile(), mode)
  } catch (err) {
    console.warn(`could not save the appearance: ${err.message}`)
  }
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('destroyed', () => closeSockets(contents.id))
  // A reload leaves its sessions attached unless their sockets go first.
  contents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) closeSockets(contents.id)
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isHttp(url)) void shell.openExternal(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' }
    // Sign-in opens a blank tab and then points it at the provider; that goes to the browser.
    if (url === '' || url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
    if (isHttp(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', child => {
    if (child.webContents.getURL() !== 'about:blank' && child.webContents.getURL() !== '') return
    child.webContents.on('did-start-navigation', ({ url, isMainFrame }) => {
      if (!isMainFrame || !isHttp(url)) return
      void shell.openExternal(url)
      child.destroy()
    })
  })
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Claude Code',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(APP_URL)
}

function fail(message) {
  dialog.showErrorBox('Claude Code', message)
  app.exit(1)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    nativeTheme.themeSource = readThemeMode(themeFile())
    // The app's own page may ask (clipboard, notifications); frames from elsewhere may not.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback, details) => {
      callback(isAppUrl(details.requestingUrl))
    })
    // protocol.handle gets no Origin, so the server could not tell the page's
    // own fetches from a form or no-cors fetch posted by a previewed site.
    // Set it from the frame that made the request; navigations never post.
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${SCHEME}://*/*`] }, (details, callback) => {
      const requestHeaders = { ...details.requestHeaders }
      for (const key of Object.keys(requestHeaders)) if (key.toLowerCase() === 'origin') delete requestHeaders[key]
      if (details.method !== 'GET' && details.method !== 'HEAD') {
        requestHeaders.Origin = details.resourceType === 'xhr' && details.frame ? details.frame.origin : 'null'
      }
      callback({ requestHeaders })
    })
    const recent = []
    sidecar = startSidecar({
      command: sidecarCommand(),
      env: await loginShellEnv(),
      appOrigin: APP_ORIGIN,
      log: line => {
        console.log(`[claude] ${line}`)
        recent.push(line)
        if (recent.length > 20) recent.shift()
      },
      onExit: (code, signal) => {
        if (!stopped) fail(`claude stopped unexpectedly (${signal ?? code}).\n\n${recent.join('\n')}`)
      },
    })
    protocol.handle(SCHEME, request =>
      new URL(request.url).host === 'app' ? sidecar.fetch(request) : new Response(null, { status: 404 }),
    )
    try {
      await sidecar.ready
    } catch (err) {
      return fail(`${err.message}\n\n${recent.join('\n')}`)
    }
    createWindow()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (stopped || !sidecar) return
    event.preventDefault()
    stopped = true
    void sidecar.stop().finally(() => app.quit())
  })
}
