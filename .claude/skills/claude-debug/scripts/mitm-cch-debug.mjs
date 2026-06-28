#!/usr/bin/env node
import net from 'node:net'
import tls from 'node:tls'
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { summarizeJsonBody } from './mitm-cch-summary.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg?.startsWith('--')) {
    const next = process.argv[i + 1]
    args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'true')
    if (next && !next.startsWith('--')) i += 1
  }
}

const port = Number(args.get('port') ?? 8910)
const host = args.get('host') ?? '127.0.0.1'
const logPath = args.get('log') ?? '/tmp/claude-mitm-cch-debug.jsonl'
const certPath = args.get('cert')
const keyPath = args.get('key')
const caPath = args.get('ca')
const saveBodyPrefix = args.get('save-body-prefix') || null
const hostMappings = new Map(
  [...args.entries()]
    .filter(([key]) => key === 'map-host')
    .flatMap(([, value]) => String(value).split(','))
    .map(entry => entry.split('='))
    .filter(parts => parts.length === 2 && parts[0] && parts[1]),
)

if (!certPath || !keyPath) {
  console.error('usage: node mitm-cch-debug.mjs --cert leaf.crt.pem --key leaf.key.pem [--ca ca.crt.pem] [--port 8910] [--log /tmp/mitm.jsonl]')
  process.exit(2)
}

const serverTlsOptions = {
  cert: readFileSync(certPath),
  key: readFileSync(keyPath),
}
const upstreamTlsOptions = caPath ? { ca: readFileSync(caPath) } : {}

function log(event) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

function redactHeader(line) {
  const key = line.split(':', 1)[0] ?? ''
  if (/authorization|cookie|token|key|secret/i.test(key)) return `${key}: <redacted>`
  return line
}

function parseHeaders(lines) {
  const headers = []
  let contentLength = 0
  for (const line of lines) {
    if (!line) continue
    headers.push(redactHeader(line))
    const marker = line.indexOf(':')
    if (marker === -1) continue
    const name = line.slice(0, marker).trim().toLowerCase()
    const value = line.slice(marker + 1).trim()
    if (name === 'content-length') contentLength = Number(value) || 0
  }
  return { headers, contentLength }
}

function recvUntil(socket, marker = Buffer.from('\r\n\r\n'), limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    function cleanup() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
    }
    function onData(chunk) {
      data = Buffer.concat([data, chunk])
      if (data.includes(marker) || data.length >= limit) {
        cleanup()
        resolve(data)
      }
    }
    function onError(error) {
      cleanup()
      reject(error)
    }
    function onEnd() {
      cleanup()
      resolve(data)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('end', onEnd)
  })
}

function readHttpRequest(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let marker = -1
    let contentLength = 0
    let headers = []
    let requestLine = ''

    function cleanup() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
    }

    function parseHeadIfReady() {
      if (marker !== -1) return
      marker = buffer.indexOf('\r\n\r\n')
      if (marker === -1) return
      const head = buffer.subarray(0, marker)
      const lines = head.toString('latin1').split('\r\n')
      requestLine = lines.shift() ?? ''
      ;({ headers, contentLength } = parseHeaders(lines))
    }

    function maybeResolve() {
      parseHeadIfReady()
      if (marker === -1) return
      const bodyStart = marker + 4
      if (buffer.length < bodyStart + contentLength) return
      cleanup()
      const head = buffer.subarray(0, marker)
      const bodyEnd = bodyStart + contentLength
      const body = buffer.subarray(bodyStart, bodyEnd)
      const extra = buffer.subarray(bodyEnd)
      if (extra.length) socket.unshift(extra)
      resolve({ requestLine, headers, contentLength, body, raw: Buffer.concat([head, Buffer.from('\r\n\r\n'), body]) })
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      maybeResolve()
    }
    function onError(error) {
      cleanup()
      reject(error)
    }
    function onEnd() {
      cleanup()
      const head = marker === -1 ? buffer : buffer.subarray(0, marker)
      const bodyStart = marker === -1 ? buffer.length : marker + 4
      const body = buffer.subarray(bodyStart)
      resolve({ requestLine, headers, contentLength, body, raw: Buffer.concat([head, Buffer.from('\r\n\r\n'), body]) })
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('end', onEnd)
  })
}

function pipeWithCounts(source, target, direction, metadata) {
  let bytes = 0
  source.on('data', chunk => {
    bytes += chunk.length
    target.write(chunk)
  })
  source.on('end', () => target.end())
  source.on('close', () => log({ type: 'pipe_close', direction, bytes, ...metadata }))
  source.on('error', error => log({ type: 'pipe_error', direction, error: error.message, ...metadata }))
}

async function handleClient(clientSocket) {
  let target = null
  try {
    const connectHead = await recvUntil(clientSocket)
    const connectLine = connectHead.toString('latin1').split('\r\n', 1)[0]
    if (!connectLine.startsWith('CONNECT ')) {
      log({ type: 'non_connect', request_line: connectLine })
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    target = connectLine.split(/\s+/)[1]
    const [hostname, portText] = target.split(':')
    const targetPort = Number(portText || 443)
    log({ type: 'connect', target })
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    const clientTls = new tls.TLSSocket(clientSocket, { isServer: true, ...serverTlsOptions })
    await new Promise((resolve, reject) => {
      clientTls.once('secure', resolve)
      clientTls.once('error', reject)
    })

    const connectHost = hostMappings.get(hostname) ?? hostname
    const upstreamTls = tls.connect({ host: connectHost, port: targetPort, servername: hostname, ...upstreamTlsOptions })
    await new Promise((resolve, reject) => {
      upstreamTls.once('secureConnect', resolve)
      upstreamTls.once('error', reject)
    })

    const request = await readHttpRequest(clientTls)
    const bodySummary = summarizeJsonBody(request.body)
    const event = {
      type: 'decrypted_request_summary',
      target,
      request_line: request.requestLine,
      headers: request.headers,
      body_summary: bodySummary,
    }
    if (saveBodyPrefix) {
      const path = `${saveBodyPrefix}-${Date.now()}.body`
      appendFileSync(path, request.body)
      event.body_path = path
    }
    log(event)

    upstreamTls.write(request.raw)
    pipeWithCounts(clientTls, upstreamTls, 'client_to_target', { target })
    pipeWithCounts(upstreamTls, clientTls, 'target_to_client', { target })
  } catch (error) {
    log({ type: 'mitm_error', target, error: error instanceof Error ? error.message : String(error) })
    clientSocket.destroy()
  }
}

const server = net.createServer(socket => {
  handleClient(socket)
})

server.listen(port, host, () => {
  console.log(`mitm cch debug listening on http://${host}:${port}`)
  console.log(`log: ${logPath}`)
  console.log('warning: this proxy decrypts HTTPS for local authorized debugging; logs are sensitive and headers are redacted, but body artifacts are only written when --save-body-prefix is set')
})
