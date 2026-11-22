// Session sockets for the page (web/src/api.ts `DesktopBridge`), relayed by the main process.
const { contextBridge, ipcRenderer } = require('electron')

const listeners = new Map()
let next = 0

ipcRenderer.on('socket:event', (_event, n, type, data, code, reason) => {
  const listener = listeners.get(n)
  if (!listener) return
  if (type === 'close') listeners.delete(n)
  listener(type, data, code, reason)
})

contextBridge.exposeInMainWorld('claudeDesktop', {
  socket(path, onEvent) {
    const n = ++next
    listeners.set(n, onEvent)
    ipcRenderer.send('socket:open', n, path)
    return {
      send: data => ipcRenderer.send('socket:send', n, data),
      close: (code, reason) => ipcRenderer.send('socket:close', n, code, reason),
    }
  },
})
