import { createHash } from 'crypto'

/**
 * The page a Mod's `Client` surface modules run under: a sandboxed frame of
 * its own (opaque origin, no network, no eval) that starts one Worker for the
 * mod's code and relays between it and the page over a MessagePort. The Worker
 * runs the official surface runtime; a watchdog ends it when it stops beating.
 */
export const MODS_FRAME_PATH = '/mods-frame'

// The Worker. Strings only (no template holes), so the bundler cannot rewrite it.
const WORKER = String.raw`
const send = self.postMessage.bind(self)
const later = setTimeout.bind(self)
const every = setInterval.bind(self)
const stop = clearInterval.bind(self)
every(() => send({ op: 'beat' }), 500)
let api, run, ready
const draws = new Map()
const live = new Set()
const timers = new Map()
const held = new Map()
const loops = new Map()
let rendering = 0
let timerSeq = 0
const reasonOf = error => {
  try { return String(error && typeof error === 'object' ? error.message : error).slice(0, 2000) } catch { return 'an error that could not be read' }
}
function fault(id, phase, reason) {
  if (!live.has(id)) return
  live.delete(id)
  for (const [timer, owner] of timers) if (owner.id === id) { stop(owner.handle); timers.delete(timer) }
  held.delete(id)
  loops.delete(id)
  try { api.unmount(id) } catch {}
  send({ op: 'fault', id, phase, reason })
}
function call(id, kind, payload, phase) {
  try {
    api.stage(id, kind, payload)
    return run()
  } catch (error) {
    fault(id, phase, reasonOf(error))
  }
}
function render(id) {
  if (!live.has(id)) return
  rendering = id
  const text = call(id, 'render', undefined, 'render')
  rendering = 0
  if (typeof text !== 'string' || !live.has(id)) return
  // Closures of the drawing before last are retired; the last one's may still be pressed.
  const handles = [...text.matchAll(/"held":(\d+)/g)].map(m => Number(m[1]))
  const kept = held.get(id) ?? [[], []]
  try { api.dropHeld(id, kept[0]) } catch {}
  held.set(id, [kept[1], handles])
  send({ op: 'tree', id, text })
}
const host = {
  schedule(id) {
    if (rendering === id) {
      const n = (loops.get(id) ?? 0) + 1
      loops.set(id, n)
      if (n >= 3) return later(() => fault(id, 'run', 'Client render loop: each drawing set state again'), 0)
    } else loops.set(id, 0)
    later(() => render(id), 16)
  },
  startTimer(id, ms) {
    const timer = ++timerSeq
    const handle = every(() => { loops.set(id, 0); call(id, 'tick', timer, 'run') }, Math.max(16, ms))
    timers.set(timer, { id, handle })
    return timer
  },
  stopTimer(id, timer) {
    const owner = timers.get(timer)
    if (owner) { stop(owner.handle); timers.delete(timer) }
  },
  post(id, text) { send({ op: 'post', id, text }) },
  fault(id, reason) { fault(id, 'run', reason) },
}
async function load(bundle) {
  const files = new Map(bundle.files.map(f => [f.key, f.source]))
  const urls = new Map()
  const visiting = new Set()
  const urlOf = key => {
    if (urls.has(key)) return urls.get(key)
    const source = files.get(key)
    if (source === undefined) throw new Error('Client module ' + key + ' is not in the bundle')
    if (visiting.has(key)) throw new Error('Client modules import each other in a cycle at ' + key)
    visiting.add(key)
    const text = source.replace(/(["'])((?:surface:\/\/\/|claude:)[^"'\n]*)\1/g, (m, q, spec) => files.has(spec) ? JSON.stringify(urlOf(spec)) : m)
    visiting.delete(key)
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
    urls.set(key, url)
    return url
  }
  const runtime = await import(urlOf('claude:surface-runtime'))
  globalThis.h = runtime.h
  globalThis.Fragment = runtime.Fragment
  api = runtime.install(host, bundle.limits)
  run = globalThis.__surface__.run
  // What the official environment leaves out: no network, no timers, no code from strings.
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'WebAssembly', 'postMessage', 'close', 'navigator']) {
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }) } catch {}
  }
  for (const m of bundle.modules) {
    const ns = await import(urlOf(m.entry))
    draws.set(m.module, ns[m.component])
  }
}
self.addEventListener('message', async event => {
  const msg = event.data
  if (msg.op === 'load') {
    ready = load(msg.bundle).then(() => send({ op: 'loaded' }), error => { send({ op: 'broken', reason: reasonOf(error) }); throw error })
    return
  }
  try { await ready } catch { return }
  const id = msg.id
  if (msg.op === 'mount') {
    const draw = draws.get(msg.module)
    if (typeof draw !== 'function') return send({ op: 'fault', id, phase: 'load', reason: 'Client module ' + msg.module + ' is not in the bundle' })
    try {
      api.mount(id, draw, msg.props)
      api.resize(id, msg.columns, msg.rows)
    } catch (error) {
      return send({ op: 'fault', id, phase: 'load', reason: reasonOf(error) })
    }
    live.add(id)
    render(id)
  } else if (!live.has(id)) {
    return
  } else if (msg.op === 'props') {
    loops.set(id, 0)
    try { api.setProps(id, msg.props) } catch {}
    render(id)
  } else if (msg.op === 'resize') {
    try { api.resize(id, msg.columns, msg.rows) } catch {}
    render(id)
  } else if (msg.op === 'held') {
    loops.set(id, 0)
    call(id, 'held', { handle: msg.handle, event: msg.event }, 'run')
  } else if (msg.op === 'key' || msg.op === 'pointer') {
    loops.set(id, 0)
    if (api.hasListener(id, msg.op)) call(id, msg.op, msg.event, 'run')
  } else if (msg.op === 'unmount') {
    live.delete(id)
    for (const [timer, owner] of timers) if (owner.id === id) { stop(owner.handle); timers.delete(timer) }
    held.delete(id)
    try { api.unmount(id) } catch {}
  }
})
`

// The frame: hands the page's port to the Worker and keeps the watchdog.
const FRAME = String.raw`(() => {
  const WORKER = ${JSON.stringify(WORKER)}
  const LIMIT = 200000
  let port, worker, bundle, beat = 0, watch = 0, loaded = false, broken
  const mounted = new Set()
  const toPage = msg => port.postMessage(msg)
  const die = (phase, reason) => {
    if (worker) worker.terminate()
    worker = undefined
    clearInterval(watch)
    for (const id of mounted) toPage({ op: 'fault', id, phase, reason })
    mounted.clear()
  }
  const start = () => {
    loaded = false
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
    worker.onerror = e => { e.preventDefault(); broken = String(e.message || 'the Client runtime failed to start'); die('load', broken) }
    worker.onmessage = e => fromWorker(e.data)
    worker.postMessage({ op: 'load', bundle })
    beat = Date.now()
    watch = setInterval(() => {
      if (Date.now() - beat > 2000) die(loaded ? 'run' : 'load', 'the Client stopped answering for 2 seconds and was stopped')
    }, 250)
  }
  const fromWorker = msg => {
    if (!msg || typeof msg !== 'object') return
    if (msg.op === 'beat') beat = Date.now()
    else if (msg.op === 'loaded') loaded = true
    else if (msg.op === 'broken') { broken = String(msg.reason).slice(0, 2000); die('load', broken) }
    else if (!Number.isInteger(msg.id) || !mounted.has(msg.id)) return
    else if (msg.op === 'tree' && typeof msg.text === 'string' && msg.text.length <= LIMIT) toPage({ op: 'tree', id: msg.id, text: msg.text })
    else if (msg.op === 'post' && typeof msg.text === 'string' && msg.text.length <= LIMIT) toPage({ op: 'post', id: msg.id, text: msg.text })
    else if (msg.op === 'fault') {
      mounted.delete(msg.id)
      toPage({ op: 'fault', id: msg.id, phase: ['load', 'render', 'run'].includes(msg.phase) ? msg.phase : 'run', reason: String(msg.reason).slice(0, 2000) })
    }
  }
  const fromPage = msg => {
    if (!msg || typeof msg !== 'object') return
    if (msg.op === 'load') {
      die('load', 'the Mod was reloaded')
      bundle = msg.bundle
      broken = undefined
      return
    }
    if (!Number.isInteger(msg.id)) return
    if (msg.op === 'mount') {
      if (broken !== undefined) return toPage({ op: 'fault', id: msg.id, phase: 'load', reason: broken })
      if (!bundle) return
      if (!worker) start()
      mounted.add(msg.id)
    } else if (!mounted.has(msg.id) || !worker) return
    if (msg.op === 'unmount') mounted.delete(msg.id)
    worker.postMessage(msg)
  }
  addEventListener('message', e => {
    if (port || e.source !== parent || e.data !== 'claude-mods-frame' || !e.ports[0]) return
    port = e.ports[0]
    port.onmessage = m => fromPage(m.data)
  })
})()`

const FRAME_HASH = createHash('sha256').update(FRAME).digest('base64')

/** The frame's own policy: its one script, Workers and modules from blob: alone, nothing to connect to. */
export const MODS_FRAME_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${FRAME_HASH}' blob:`,
  'worker-src blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
].join('; ')

export const MODS_FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>Mod client</title><script>${FRAME}</script>`
