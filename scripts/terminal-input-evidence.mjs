import * as xterm from '@xterm/headless'
import { createHash } from 'node:crypto'

const Terminal = xterm.Terminal ?? xterm.default?.Terminal ?? xterm['module.exports']?.Terminal
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (terminal, bytes) => new Promise(resolve => terminal.write(bytes, resolve))

// Terminal replies are a different input producer. Recognize them only after
// an actual parsed query, never by deleting arbitrary escape strings from input.
export async function verifyNativeInputEvents(raw, io, intended) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 200, rows: 60,
    convertEol: false, logLevel: 'off' })
  const queries = [], replies = [], user = [], actual = []
  let current, buffered = Buffer.alloc(0), consumed = 0
  const handlers = [
    terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, params => {
      if (params.length === 1 && params[0] === 0)
        queries.push({ kind: 'version', ioId: current.ioId, rawOffset: current.rawOffset })
      return false
    }),
    terminal.parser.registerCsiHandler({ final: 'c' }, params => {
      if (params.length === 1 && params[0] === 0)
        queries.push({ kind: 'primary-attributes', ioId: current.ioId, rawOffset: current.rawOffset })
      return false
    }),
  ]
  const consume = (final = false) => {
    while (buffered.length) {
      const query = queries[0], text = buffered.toString('latin1')
      let match
      if (query?.kind === 'version' && text.startsWith('\x1bP>|')) {
        const end = text.indexOf('\x1b\\', 4)
        if (end >= 4 && /^tmux [0-9]+\.[0-9]+[a-z]?$/.test(text.slice(4, end)))
          match = [text.slice(0, end + 2)]
      } else if (query?.kind === 'primary-attributes' && text.startsWith('\x1b[?1;2;4c'))
        match = ['\x1b[?1;2;4c']
      if (match) {
        const bytes = Buffer.from(match[0], 'latin1')
        if (intended.subarray(consumed, consumed + bytes.length).equals(bytes))
          throw Error('Ambiguous terminal reply versus driver input')
        replies.push({ ...query, responseIoId: current.ioId, hex: bytes.toString('hex') })
        queries.shift()
        buffered = buffered.subarray(bytes.length)
        continue
      }
      const prefix = query?.kind === 'version' ? '\x1bP>|' :
        query?.kind === 'primary-attributes' ? '\x1b[?' : null
      if (prefix && (prefix.startsWith(text) || text.startsWith(prefix)) && !final) {
        if (buffered.length > 96) throw Error('Invalid bounded terminal reply')
        return
      }
      user.push(buffered)
      consumed += buffered.length
      buffered = Buffer.alloc(0)
    }
  }
  try {
    for (const event of io) {
      current = event
      if (event.kind === 'output') {
        await write(terminal, raw.subarray(event.start, event.end))
      } else if (event.kind === 'input') {
        if (!/^(?:[a-f0-9]{2})+$/.test(event.hex))
          throw Error('Invalid native input byte journal')
        const bytes = Buffer.from(event.hex, 'hex')
        actual.push(bytes)
        buffered = Buffer.concat([buffered, bytes])
        consume()
      }
    }
    consume(true)
    const userBytes = Buffer.concat(user), all = Buffer.concat(actual)
    if (!userBytes.equals(intended))
      throw Error('Native input differs from ordered driver bytes and parsed terminal replies')
    return {
      verdict: 'passed', method: 'parsed-native-terminal-input-v1',
      driverBytes: intended.length, nativeBytes: all.length,
      intendedSHA256: hash(intended), nativeInputSHA256: hash(all),
      terminalReplies: replies,
      chunkClaim: 'ordered bytes; operating-system read grouping is not asserted',
    }
  } finally {
    handlers.forEach(handler => handler.dispose())
    terminal.dispose()
  }
}

/** Bind decoded actual child read prefixes to the complete broker input stream. */
export async function verifyNativeChildInputReads(raw, io, intended, prefixes) {
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some(bytes => !Buffer.isBuffer(bytes)))
    throw Error('Decoded actual child read prefixes are required')
  const child = Buffer.concat(prefixes)
  const input = await verifyNativeInputEvents(raw, io, intended)
  if (hash(child) !== input.nativeInputSHA256 || child.length !== input.nativeBytes)
    throw Error('Actual child read bytes differ from the complete broker input stream')
  return { ...input, method: 'parsed-native-child-input-v1', parentMethod: input.method,
    childReadBytes: child.length, childReadSHA256: hash(child),
    actualInputOwnerCovered: false, productTimingEquivalent: false }
}
