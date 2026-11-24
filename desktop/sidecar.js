import { spawn } from 'node:child_process'

// The other end is src/web/stdioTransport.ts (`claude web --stdio`); these must match it.
export const FRAME_PREFIX = '\x1eclaude-web '
export const SERVER_HOST = 'claude-desktop'
const SERVER_ORIGIN = `http://${SERVER_HOST}`
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

/**
 * Starts `claude web --stdio` and relays the app's requests and session
 * sockets to it. `appOrigin` is the page's origin; the server sees it as its own.
 */
export function startSidecar({ command, args = ['web', '--stdio'], env, appOrigin, log = () => {}, onExit = () => {} }) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const requests = new Map()
  const sockets = new Map()
  let nextId = 0
  let exited = false
  let markReady
  let failStart
  const ready = new Promise((resolve, reject) => {
    markReady = resolve
    failStart = reject
  })

  const send = frame => {
    if (!exited) child.stdin.write(FRAME_PREFIX + JSON.stringify(frame) + '\n')
  }

  const toServerHeaders = headers => {
    const out = []
    for (const [key, value] of headers) {
      if (key === 'host') continue
      out.push([key, key === 'origin' && value === appOrigin ? SERVER_ORIGIN : value])
    }
    out.push(['host', SERVER_HOST])
    return out
  }

  function receive(frame) {
    if (frame.t === 'ready') return markReady()
    const request = requests.get(frame.id)
    if (request) {
      if (frame.t === 'res') request.head(frame)
      else if (frame.t === 'body') request.chunk(Buffer.from(frame.data, 'base64'))
      else if (frame.t === 'end') request.end()
      return
    }
    const listener = sockets.get(frame.id)
    if (!listener) return
    if (frame.t === 'wsopen') listener('open')
    else if (frame.t === 'wsmsg') listener('message', frame.data)
    else if (frame.t === 'wsclose') {
      sockets.delete(frame.id)
      listener('close', undefined, frame.code, frame.reason)
    }
  }

  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    let newline
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (!line.startsWith(FRAME_PREFIX)) {
        if (line.trim()) log(line)
        continue
      }
      try {
        receive(JSON.parse(line.slice(FRAME_PREFIX.length)))
      } catch (err) {
        log(`bad frame: ${err.message}`)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => log(chunk.trimEnd()))
  // Writing after the child is gone surfaces here; the exit handler reports it.
  child.stdin.on('error', () => {})

  const exitedPromise = new Promise(resolve => {
    const finish = (code, signal) => {
      if (exited) return
      exited = true
      failStart(new Error(`claude exited before it was ready (${signal ?? code})`))
      for (const request of requests.values()) request.fail(new Error('claude exited'))
      for (const listener of sockets.values()) listener('close', undefined, 1006, 'claude exited')
      requests.clear()
      sockets.clear()
      onExit(code, signal)
      resolve()
    }
    child.on('exit', finish)
    child.on('error', err => {
      log(`could not start ${command}: ${err.message}`)
      finish(null, err.code ?? 'error')
    })
  })

  /** A Fetch API request to the server; resolves once the response head arrives. */
  async function fetch(request) {
    const url = new URL(request.url)
    const id = ++nextId
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined
    return new Promise((resolve, reject) => {
      if (exited) return reject(new Error('claude exited'))
      let controller
      const stream = new ReadableStream({
        start: c => {
          controller = c
        },
        cancel: () => {
          requests.delete(id)
          send({ t: 'cancel', id })
        },
      })
      requests.set(id, {
        head: frame => {
          const nullBody = NULL_BODY_STATUS.has(frame.status) || request.method === 'HEAD'
          resolve(new Response(nullBody ? null : stream, { status: frame.status, headers: frame.headers }))
        },
        chunk: data => controller.enqueue(new Uint8Array(data)),
        end: () => {
          requests.delete(id)
          controller.close()
        },
        fail: err => {
          reject(err)
          controller.error(err)
        },
      })
      request.signal?.addEventListener('abort', () => {
        if (!requests.delete(id)) return
        send({ t: 'cancel', id })
        controller.error(new Error('aborted'))
      })
      send({
        t: 'req',
        id,
        method: request.method,
        path: url.pathname + url.search,
        headers: toServerHeaders(request.headers),
        ...(body && { body: body.toString('base64') }),
      })
    })
  }

  /** A session socket; `onEvent('open' | 'message' | 'close', data, code, reason)`. */
  function socket(path, onEvent) {
    const id = ++nextId
    if (exited) {
      queueMicrotask(() => onEvent('close', undefined, 1006, 'claude exited'))
      return { send: () => {}, close: () => {} }
    }
    sockets.set(id, onEvent)
    send({ t: 'ws', id, path, headers: toServerHeaders([['origin', appOrigin]]) })
    return {
      send: data => {
        if (sockets.has(id)) send({ t: 'wsmsg', id, data })
      },
      close: (code = 1000, reason = '') => {
        if (!sockets.delete(id)) return
        send({ t: 'wsclose', id, code, reason })
        // A browser reports its own close too.
        queueMicrotask(() => onEvent('close', undefined, code, reason))
      },
    }
  }

  /** Closes the pipe, which stops the server; kills it if it is still running after `graceMs`. */
  async function stop(graceMs = 5000) {
    if (exited) return
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), graceMs)
    await exitedPromise
    clearTimeout(timer)
  }

  return { ready, fetch, socket, stop, pid: child.pid }
}
