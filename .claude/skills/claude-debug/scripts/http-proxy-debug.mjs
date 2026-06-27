#!/usr/bin/env node
import http from 'node:http'
import net from 'node:net'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { URL } from 'node:url'
import process from 'node:process'
import { Buffer } from 'node:buffer'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg?.startsWith('--')) {
    const next = process.argv[i + 1]
    args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'true')
    if (next && !next.startsWith('--')) i += 1
  }
}

const port = Number(args.get('port') ?? 8899)
const host = args.get('host') ?? '127.0.0.1'
const logPath = args.get('log') ?? '/tmp/claude-proxy-debug.jsonl'
const dumpDir = args.get('dump-dir') || null
const dumpBodyLimit = Number(args.get('dump-body-limit') ?? 16384)
const upstream = args.get('upstream') ? new URL(args.get('upstream')) : null

if (dumpDir) mkdirSync(dumpDir, { recursive: true })

function log(event) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

let exchangeId = 0

function nextExchangeId(prefix) {
  exchangeId += 1
  return `${prefix}-${String(exchangeId).padStart(4, '0')}`
}

function nowMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

function makeExchange(kind, target) {
  const id = nextExchangeId(kind)
  const startedAt = process.hrtime.bigint()
  const file = dumpDir ? join(dumpDir, `${id}.jsonl`) : null
  if (dumpDir) {
    const event = { kind: 'exchange_start', id, protocol: kind, target, at: new Date().toISOString(), file }
    appendFileSync(join(dumpDir, 'index.jsonl'), `${JSON.stringify(event)}\n`)
    appendFileSync(file, `${JSON.stringify(event)}\n`)
  }
  return { id, protocol: kind, target, startedAt, file }
}

function recordChunk(exchange, direction, chunk) {
  if (!dumpDir || !exchange?.file) return
  const saved = chunk.subarray(0, Math.max(0, dumpBodyLimit))
  const event = {
    kind: 'chunk',
    id: exchange.id,
    protocol: exchange.protocol,
    target: exchange.target,
    direction,
    at: new Date().toISOString(),
    t_offset_ms: Math.round(nowMs(exchange.startedAt) * 1000) / 1000,
    bytes: chunk.length,
    saved_bytes: saved.length,
    truncated: saved.length < chunk.length,
    encoding: 'base64',
    data_base64: saved.toString('base64'),
    preview_utf8: saved.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�'),
  }
  const line = `${JSON.stringify(event)}\n`
  appendFileSync(exchange.file, line)
  appendFileSync(join(dumpDir, 'index.jsonl'), line)
}

function endExchange(exchange, extra = {}) {
  if (!dumpDir || !exchange?.file) return
  const event = {
    kind: 'exchange_end',
    id: exchange.id,
    protocol: exchange.protocol,
    target: exchange.target,
    at: new Date().toISOString(),
    t_offset_ms: Math.round(nowMs(exchange.startedAt) * 1000) / 1000,
    ...extra,
  }
  const line = `${JSON.stringify(event)}\n`
  appendFileSync(exchange.file, line)
  appendFileSync(join(dumpDir, 'index.jsonl'), line)
}

function redactHeaders(headers) {
  const out = { ...headers }
  for (const key of Object.keys(out)) {
    if (/authorization|cookie|token|key|secret/i.test(key)) out[key] = '<redacted>'
  }
  return out
}

function redactUrl(url) {
  if (!url) return null
  const out = new URL(url.href)
  if (out.username) out.username = '<redacted>'
  if (out.password) out.password = '<redacted>'
  return out.href
}

function parseTarget(authority) {
  const [hostname, portText] = authority.split(':')
  return { hostname, port: Number(portText || 443) }
}

function connectViaUpstream(authority, onReady, onError) {
  if (!upstream) {
    const { hostname, port } = parseTarget(authority)
    const socket = net.connect(port, hostname, () => onReady(socket))
    socket.on('error', onError)
    return
  }

  const socket = net.connect(Number(upstream.port || 8080), upstream.hostname, () => {
    const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
    if (upstream.username || upstream.password) {
      const auth = Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')
      headers.push(`Proxy-Authorization: Basic ${auth}`)
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  })
  socket.once('data', chunk => {
    const head = chunk.toString('latin1')
    if (!/^HTTP\/1\.[01] 2\d\d/.test(head)) {
      onError(new Error(`upstream CONNECT failed: ${head.split('\r\n')[0]}`))
      socket.destroy()
      return
    }
    const marker = head.indexOf('\r\n\r\n')
    const rest = marker === -1 ? Buffer.alloc(0) : chunk.subarray(marker + 4)
    onReady(socket, rest)
  })
  socket.on('error', onError)
}

function pipeWithCounts(clientSocket, targetSocket, initialTargetBytes = Buffer.alloc(0), metadata = {}, exchange = null) {
  let c2t = 0
  let t2c = initialTargetBytes.length

  clientSocket.on('data', chunk => {
    c2t += chunk.length
    recordChunk(exchange, 'client_to_target', chunk)
    targetSocket.write(chunk)
  })
  targetSocket.on('data', chunk => {
    t2c += chunk.length
    recordChunk(exchange, 'target_to_client', chunk)
    clientSocket.write(chunk)
  })
  targetSocket.on('close', () => {
    log({ type: 'tunnel_close', ...metadata, bytes_client_to_target: c2t, bytes_target_to_client: t2c })
    endExchange(exchange, { bytes_client_to_target: c2t, bytes_target_to_client: t2c })
    clientSocket.end()
  })
  clientSocket.on('close', () => {
    targetSocket.end()
  })

  if (initialTargetBytes.length) {
    recordChunk(exchange, 'target_to_client', initialTargetBytes)
    clientSocket.write(initialTargetBytes)
  }
  clientSocket.resume()
  targetSocket.resume()
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const exchange = makeExchange('http', req.url)
    recordChunk(exchange, 'client_to_target', body)
    log({
      type: 'http_request',
      exchange_id: exchange.id,
      method: req.method,
      target: req.url,
      headers: redactHeaders(req.headers),
      request_bytes: body.length,
    })

    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('proxy requires absolute-form URL for plain HTTP requests')
      endExchange(exchange, { error: 'proxy requires absolute-form URL for plain HTTP requests' })
      return
    }

    if (target.protocol !== 'http:') {
      res.writeHead(501)
      res.end('plain forwarding only supports http:// targets; use CONNECT for https://')
      endExchange(exchange, { error: 'plain forwarding only supports http:// targets; use CONNECT for https://' })
      return
    }

    const options = upstream
      ? {
          hostname: upstream.hostname,
          port: Number(upstream.port || 8080),
          method: req.method,
          path: req.url,
          headers: req.headers,
        }
      : {
          hostname: target.hostname,
          port: Number(target.port || 80),
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: req.headers,
        }

    const proxyReq = http.request(options, proxyRes => {
      log({
        type: 'http_response',
        exchange_id: exchange.id,
        method: req.method,
        target: req.url,
        status: proxyRes.statusCode,
        headers: redactHeaders(proxyRes.headers),
      })
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.on('data', chunk => {
        recordChunk(exchange, 'target_to_client', chunk)
        res.write(chunk)
      })
      proxyRes.on('end', () => {
        endExchange(exchange, { status: proxyRes.statusCode })
        res.end()
      })
    })
    proxyReq.on('error', error => {
      log({ type: 'http_error', target: req.url, error: error.message })
      endExchange(exchange, { error: error.message })
      res.writeHead(502)
      res.end(error.message)
    })
    proxyReq.end(body)
  })
})

server.on('connect', (req, clientSocket, head) => {
  const authority = req.url
  const exchange = makeExchange('connect', authority)
  log({ type: 'connect', exchange_id: exchange.id, target: authority, headers: redactHeaders(req.headers), upstream: redactUrl(upstream) })
  connectViaUpstream(
    authority,
    (targetSocket, initialTargetBytes = Buffer.alloc(0)) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) {
        recordChunk(exchange, 'client_to_target', head)
        targetSocket.write(head)
      }
      pipeWithCounts(clientSocket, targetSocket, initialTargetBytes, { target: authority }, exchange)
    },
    error => {
      log({ type: 'connect_error', exchange_id: exchange.id, target: authority, error: error.message })
      endExchange(exchange, { error: error.message })
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      clientSocket.destroy()
    },
  )
})

server.on('upgrade', (req, socket, head) => {
  const exchange = makeExchange('upgrade', req.url)
  log({ type: 'upgrade', exchange_id: exchange.id, target: req.url, headers: redactHeaders(req.headers) })
  let target
  try {
    target = new URL(req.url)
  } catch {
    log({ type: 'upgrade_error', exchange_id: exchange.id, target: req.url, error: 'upgrade requires absolute-form ws:// or http:// URL' })
    endExchange(exchange, { error: 'upgrade requires absolute-form ws:// or http:// URL' })
    socket.destroy()
    return
  }
  const port = Number(target.port || 80)
  const targetSocket = net.connect(port, target.hostname, () => {
    const requestLine = `${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}`
    const headers = Object.entries(req.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    pipeWithCounts(socket, targetSocket, Buffer.alloc(0), { target: req.url, upgrade: true }, exchange)
    const requestHead = Buffer.from(`${requestLine}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1')
    const redactedHeaders = Object.entries(redactHeaders(req.headers)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    const redactedRequestHead = Buffer.from(`${requestLine}\r\n${redactedHeaders.join('\r\n')}\r\n\r\n`, 'latin1')
    recordChunk(exchange, 'client_to_target', redactedRequestHead)
    targetSocket.write(requestHead)
    if (head.length) {
      recordChunk(exchange, 'client_to_target', head)
      targetSocket.write(head)
    }
  })
  targetSocket.on('error', error => {
    log({ type: 'upgrade_error', exchange_id: exchange.id, target: req.url, error: error.message })
    endExchange(exchange, { error: error.message })
    socket.destroy()
  })
})

server.listen(port, host, () => {
  console.log(`claude proxy debug listening on http://${host}:${port}`)
  console.log(`log: ${logPath}`)
  if (dumpDir) {
    console.log(`dump-dir: ${dumpDir}`)
    console.log('warning: dump-dir stores raw local capture bytes for plain HTTP/ws traffic; keep artifacts local and redact before sharing')
  }
  if (upstream) console.log(`upstream: ${redactUrl(upstream)}`)
})
