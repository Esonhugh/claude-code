// Logging MITM proxy for model API traffic. Runs under node:
//   node proxy.mjs <port> <requests.jsonl>
// env: BENCH_MITM_DIR (leaf.key/leaf.crt), UPSTREAM_PROXY, BENCH_UPSTREAM_CA,
//      BENCH_DIRECT_HOSTS (comma list, default api.anthropic.com)
// One JSON line per model request: time, sizes, model, effort, usage, TTFB/TTFT.
// Headers and bodies are never written, so credentials cannot reach the log.
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

const port = Number(process.argv[2])
const logFile = process.argv[3]
const mitmDir = process.env.BENCH_MITM_DIR
const MITM = new Set(['api.anthropic.com', 'chatgpt.com', 'api.openai.com'])
const DIRECT = new Set((process.env.BENCH_DIRECT_HOSTS ?? 'api.anthropic.com').split(',').filter(Boolean))
const upstreamProxy = process.env.UPSTREAM_PROXY ? new URL(process.env.UPSTREAM_PROXY) : null
const ca = process.env.BENCH_UPSTREAM_CA ? fs.readFileSync(process.env.BENCH_UPSTREAM_CA) : undefined
let seq = 0

process.on('uncaughtException', e => {
  try { fs.appendFileSync(logFile + '.err', String(e?.stack || e) + '\n') } catch {}
})
const log = o => fs.appendFileSync(logFile, JSON.stringify(o) + '\n')

function upstreamSocket(host, cb) {
  if (DIRECT.has(host) || !upstreamProxy) {
    const s = tls.connect({ host, port: 443, servername: host, ca, ALPNProtocols: ['http/1.1'] }, () => cb(null, s))
    s.on('error', cb)
    return
  }
  const req = http.request({ host: upstreamProxy.hostname, port: upstreamProxy.port, method: 'CONNECT', path: `${host}:443` })
  req.on('connect', (res, sock) => {
    if (res.statusCode !== 200) return cb(new Error('upstream CONNECT ' + res.statusCode))
    const s = tls.connect({ socket: sock, servername: host, ca, ALPNProtocols: ['http/1.1'] }, () => cb(null, s))
    s.on('error', cb)
  })
  req.on('error', cb)
  req.end()
}

function decodeBody(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf)
  } catch {}
  return buf
}

export function summarizeRequest(host, url, bodyText) {
  const o = { host, path: url.split('?')[0] }
  try {
    const j = JSON.parse(bodyText)
    o.model = j.model
    o.stream = j.stream
    if (Array.isArray(j.messages)) o.n_msgs = j.messages.length
    if (Array.isArray(j.input)) o.n_msgs = j.input.length
    if (Array.isArray(j.tools)) o.n_tools = j.tools.length
    o.sys_chars = typeof j.system === 'string' ? j.system.length : Array.isArray(j.system) ? JSON.stringify(j.system).length : (j.instructions || '').length
    o.effort = j.reasoning?.effort ?? j.output_config?.effort ?? (j.thinking ? j.thinking.type + ':' + (j.thinking.budget_tokens ?? '') : undefined)
  } catch {}
  return o
}

// Tracks one model response stream (SSE or WebSocket JSON events).
export function makeTracker(rec) {
  return ev => {
    const t = ev.type
    if (!t) return
    if (rec.ttft_ms == null && /delta$/.test(t) && t !== 'message_delta') rec.ttft_ms = Date.now() - rec.t0
    if (t === 'message_start' && ev.message?.usage) { rec.usage = { ...ev.message.usage }; rec.model_resp = ev.message.model }
    if (t === 'message_delta' && ev.usage) rec.usage = { ...(rec.usage || {}), ...Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v != null)) }
    if (/^response\.(completed|done|incomplete|failed)$/.test(t) && ev.response) {
      rec.usage = ev.response.usage || null
      rec.model_resp = ev.response.model
      rec.resp_status = ev.response.status
    }
    if (t === 'error' || t === 'response.failed') rec.error = JSON.stringify(ev.error ?? ev.response?.error ?? ev.type).slice(0, 300)
  }
}

export function sseParser(onEvent) {
  let buf = ''
  return chunk => {
    buf += chunk.toString('utf8').replace(/\r\n/g, '\n')
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
      if (!data || data === '[DONE]') continue
      try { onEvent(JSON.parse(data)) } catch {}
    }
  }
}

const isModelPath = url => /\/v1\/messages(\?|$)|\/responses(\?|$)|\/chat\/completions/.test(url) && !/count_tokens/.test(url)

function handleRequest(req, res) {
  const host = (req.headers.host || '').split(':')[0]
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const isModel = req.method === 'POST' && isModelPath(req.url)
    const rec = isModel ? { id: ++seq, kind: 'http', t0: Date.now(), ts: new Date().toISOString(), req_bytes: body.length, ...summarizeRequest(host, req.url, decodeBody(body, req.headers['content-encoding']).toString('utf8')) } : null
    const headers = { ...req.headers }
    delete headers['accept-encoding']
    delete headers['proxy-connection']
    upstreamSocket(host, (err, sock) => {
      if (err) { res.writeHead(502); res.end(String(err)); return }
      const up = https.request({ host, method: req.method, path: req.url, headers, createConnection: () => sock }, ur => {
        res.writeHead(ur.statusCode, ur.headers)
        if (rec) { rec.status = ur.statusCode; rec.ttfb_ms = Date.now() - rec.t0 }
        const ct = ur.headers['content-type'] || ''
        const sse = rec && (ct.includes('event-stream') || rec.stream === true) ? sseParser(makeTracker(rec)) : null
        const jsonChunks = []
        ur.on('data', c => { if (sse) sse(c); else if (rec) jsonChunks.push(c); res.write(c) })
        ur.on('end', () => {
          res.end()
          if (!rec) return
          if (!sse) {
            try {
              const j = JSON.parse(decodeBody(Buffer.concat(jsonChunks), ur.headers['content-encoding']).toString('utf8'))
              rec.usage = j.usage || null; rec.model_resp = j.model
              rec.ttft_ms = Date.now() - rec.t0
              if (j.error) rec.error = JSON.stringify(j.error).slice(0, 300)
            } catch {}
          }
          rec.dur_ms = Date.now() - rec.t0
          delete rec.t0
          log(rec)
        })
      })
      up.on('error', e => { try { res.writeHead(502); res.end(String(e)) } catch {} })
      up.end(body)
    })
  })
}

// WebSocket frames (Codex responses over WS): unmask and collect JSON text frames.
export function wsFrameParser(onText) {
  let buf = Buffer.alloc(0), frag = []
  return chunk => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const b0 = buf[0], b1 = buf[1]
      let len = b1 & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const hasMask = (b1 & 0x80) !== 0
      const mOff = off; if (hasMask) off += 4
      if (buf.length < off + len) return
      let payload = buf.subarray(off, off + len)
      if (hasMask) { const m = buf.subarray(mOff, mOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3] }
      buf = buf.subarray(off + len)
      const op = b0 & 0x0f, fin = (b0 & 0x80) !== 0
      if (op === 1 || op === 0) { frag.push(payload); if (fin) { const t = Buffer.concat(frag).toString('utf8'); frag = []; onText(t) } }
    }
  }
}

function handleUpgrade(req, cSock, head) {
  const host = (req.headers.host || '').split(':')[0]
  const headers = { ...req.headers }
  delete headers['sec-websocket-extensions']
  upstreamSocket(host, (err, sock) => {
    if (err) { cSock.destroy(); return }
    const up = https.request({ host, method: 'GET', path: req.url, headers, createConnection: () => sock })
    up.on('upgrade', (ur, uSock, uHead) => {
      let h = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`
      for (let i = 0; i < ur.rawHeaders.length; i += 2) h += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`
      cSock.write(h + '\r\n')
      let cur = null
      const finish = extra => { cur.dur_ms = Date.now() - cur.t0; delete cur.t0; delete cur.track; log({ ...cur, ...extra }); cur = null }
      const fromClient = wsFrameParser(t => {
        try {
          const j = JSON.parse(t)
          if (j.type !== 'response.create') return
          if (cur) finish({ incomplete: true })
          cur = { id: ++seq, kind: 'ws', t0: Date.now(), ts: new Date().toISOString(), req_bytes: t.length, ...summarizeRequest(host, req.url, JSON.stringify(j.response ?? j)) }
          cur.track = makeTracker(cur)
        } catch {}
      })
      const fromServer = wsFrameParser(t => {
        if (!cur) return
        try {
          const j = JSON.parse(t)
          cur.track(j)
          if (/^response\.(completed|done|failed|incomplete)$/.test(j.type) || j.type === 'error') finish({})
        } catch {}
      })
      if (uHead?.length) { fromServer(uHead); cSock.write(uHead) }
      if (head?.length) { fromClient(head); uSock.write(head) }
      cSock.on('data', d => { fromClient(d); uSock.write(d) })
      uSock.on('data', d => { fromServer(d); cSock.write(d) })
      cSock.on('close', () => uSock.destroy()); uSock.on('close', () => cSock.destroy())
      cSock.on('error', () => {}); uSock.on('error', () => {})
    })
    up.on('response', r => { cSock.end(`HTTP/1.1 ${r.statusCode} x\r\n\r\n`) })
    up.on('error', () => cSock.destroy())
    up.end()
  })
}

function main() {
  const tlsServer = https.createServer({ key: fs.readFileSync(path.join(mitmDir, 'leaf.key')), cert: fs.readFileSync(path.join(mitmDir, 'leaf.crt')) })
  tlsServer.on('request', handleRequest)
  tlsServer.on('upgrade', handleUpgrade)
  const front = http.createServer((req, res) => { res.writeHead(400); res.end('proxy only') })
  front.on('connect', (req, cSock, head) => {
    const [host, p] = req.url.split(':')
    if (MITM.has(host)) {
      cSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) cSock.unshift(head)
      tlsServer.emit('connection', cSock)
      return
    }
    const done = s => { cSock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) s.write(head); s.pipe(cSock); cSock.pipe(s); s.on('error', () => cSock.destroy()); cSock.on('error', () => s.destroy()) }
    if (upstreamProxy) {
      const r = http.request({ host: upstreamProxy.hostname, port: upstreamProxy.port, method: 'CONNECT', path: req.url })
      r.on('connect', (res, s) => res.statusCode === 200 ? done(s) : cSock.end(`HTTP/1.1 ${res.statusCode} x\r\n\r\n`))
      r.on('error', () => cSock.destroy()); r.end()
    } else {
      const s = net.connect(Number(p) || 443, host, () => done(s)); s.on('error', () => cSock.destroy())
    }
  })
  front.listen(port, '127.0.0.1', () => console.log('proxy on', port))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main()
