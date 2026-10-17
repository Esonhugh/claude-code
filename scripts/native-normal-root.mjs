import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { nativeEvidenceLocation, checkNativeEvidenceLocation } from './native-evidence-location.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** The broker held this origin before Popen; frames never choose its initial state. */
export function verifyNativeNormalOrigin(run, expected, evidenceLocation) {
  if (expected.normalRootOrigin === undefined) return undefined
  const location = evidenceLocation ? checkNativeEvidenceLocation(evidenceLocation, run) : nativeEvidenceLocation(run)
  const originalRun = location.originalRun
  const receipt = expected.normalRootOrigin, path = join(originalRun, 'native-normal-origin.json')
  if (receipt?.path !== path || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? ''))
    throw Error('Native normal origin receipt is malformed')
  const bytes = location.read('native-normal-origin.json', 0o600)
  if (hash(bytes) !== receipt.sha256) throw Error('Native normal origin changed after enrollment')
  const origin = JSON.parse(bytes), m = origin.measurements
  const wanted = { pane_id: origin.pane, pid: String(origin.serverPid),
    pane_pid: String(origin.panePid), cursor_x: '0', cursor_y: '0',
    pane_width: String(expected.columns), pane_height: String(expected.rows),
    alternate_on: '0', pane_in_mode: '0', history_size: '0', origin_flag: '0',
    wrap_flag: '1', insert_flag: '0', cursor_flag: '1', scroll_region_upper: '0',
    scroll_region_lower: String(expected.rows - 1), version: '3.6b',
    pane_start_command: join(originalRun, 'launch-captured.sh') }
  if (origin.method !== 'builtin-fresh-tmux-normal-origin-v1' ||
      origin.captureId !== expected.captureId || origin.binarySha256 !== expected.binarySha256 ||
      origin.rawOffset !== 0 || origin.columns !== expected.columns || origin.rows !== expected.rows ||
      origin.socket !== join(originalRun, 'tmux.sock') || !/^%[0-9]+$/.test(origin.pane ?? '') ||
      typeof origin.target !== 'string' || !origin.target ||
      !['driverPid', 'serverPid', 'panePid'].every(key => Number.isSafeInteger(origin[key]) && origin[key] > 0) ||
      !m || Object.keys(m).length !== Object.keys(wanted).length ||
      Object.entries(wanted).some(([key, value]) => m[key] !== value) ||
      origin.productTimingEquivalent !== false || origin.fullNativeGatePassed !== false)
    throw Error('Native normal origin does not prove the restricted fresh pane state')
  const names = ['native-origin-screen.txt', 'native-origin-pending.bin', 'launch-captured.sh']
  if (!Array.isArray(origin.files) || origin.files.length !== names.length)
    throw Error('Native normal origin has no original screen/parser/wrapper files')
  const held = origin.files.map((file, index) => {
    if (file.path !== join(originalRun, names[index]) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''))
      throw Error('Native normal origin file identity differs')
    const data = location.read(names[index], index === 2 ? 0o700 : 0o600)
    if (hash(data) !== file.sha256) throw Error('Native normal origin file changed')
    return data
  })
  if (!/^[ \r\n]*$/.test(held[0].toString('utf8')) || held[1].toString('utf8') !== '\n' ||
      origin.pendingEncoding !== 'tmux-capture-p-P-C-v1' ||
      !Array.isArray(origin.commands) || origin.commands.length !== 3)
    throw Error('Native normal origin has painted cells or pending parser input')
  return origin
}

const style = cell => [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(),
  cell.getBgColor(), cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(),
  cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline()].join(':')
// Keep the established physical paint rule: foreground on an undecorated blank
// has no visible pixels; background, wide continuations and decorations stay strict.
const samePaintedStyle = (actual, wanted, char, width) => {
  if (actual === wanted) return true
  if (char !== ' ' || width !== 1) return false
  const left = actual.split(':'), right = wanted.split(':')
  return ![7, 8, 10, 11].some(index => left[index] !== '0' || right[index] !== '0') &&
    left[2] === right[2] && left[3] === right[3]
}

/** Acquire markers from parsed physical cursor rows, never from logical cells. */
export function createNativeNormalRoots(terminal, Terminal, origin) {
  const roots = new Map(), styles = new Map()
  let current, clearedForHome = false, semanticError
  const clear = () => { for (const root of roots.values()) root.marker?.dispose(); roots.clear() }
  const observers = [terminal.parser.registerCsiHandler({ final: 'J' }, params => {
    if (params[0] === 2) { clear(); clearedForHome = terminal.buffer.active.type === 'normal' }
    return false
  }), terminal.parser.registerCsiHandler({ final: 'H' }, params => {
    const home = [params[0] ?? 0, params[1] ?? 0].every(value => value === 0 || value === 1)
    if (clearedForHome && home && current && terminal.buffer.active.type === 'normal') {
      if (terminal._core?.coreService?.decPrivateModes?.origin !== false)
        semanticError = 'Normal reset anchor with unknown or active origin mode is not covered'
      else {
        current.marker = terminal.registerMarker(-terminal.buffer.active.cursorY)
        current.previousRows = 0
        roots.set(current.key, current)
        if (!current.marker) semanticError = 'Parsed HOME cursor-row marker unavailable'
      }
    }
    clearedForHome = false
    return false
  })]
  const wantedStyle = async ansi => {
    if (styles.has(ansi)) return styles.get(ansi)
    const oracle = new Terminal({ allowProposedApi: true, cols: 2, rows: 1, logLevel: 'off' })
    try {
      await new Promise(resolve => oracle.write(Buffer.from(ansi + 'X'), resolve))
      const result = style(oracle.buffer.active.getLine(0).getCell(0))
      styles.set(ansi, result)
      return result
    } finally { oracle.dispose() }
  }
  return {
    before(entry, frame) {
      current = undefined
      if (frame.buffer !== 'normal') return
      if (!origin) return
      const { rendererId, rootEpoch } = entry.native ?? {}
      if (![rendererId, rootEpoch].every(value => Number.isSafeInteger(value) && value > 0))
        throw Error('Normal native root has no original renderer identity')
      const key = `${rendererId}:${rootEpoch}`
      current = roots.get(key)
      if (!current) {
        if (entry.rootReset !== true) throw Error('Normal logical root epoch was not declared')
        current = { key, marker: undefined, previousRows: 0 }
        // A reset declaration only identifies a lifecycle. Physical cursor and
        // the held fresh origin determine the anchor after the exact prefix.
        if (terminal.buffer.active.type === 'normal' && terminal.buffer.active.cursorX === 0 &&
            terminal._core?.coreService?.decPrivateModes?.origin === false)
          current.marker = terminal.registerMarker(0)
        roots.set(key, current)
      }
    },
    async difference(frame) {
      if (!origin) return 'Normal root anchor is not covered by native geometry replay'
      if (semanticError) return semanticError
      const buffer = terminal.buffer.active, base = current?.marker?.line
      if (buffer.type !== 'normal') return `buffer ${buffer.type} != normal`
      if (frame.logicalViewport?.width !== terminal.cols || frame.logicalViewport?.height !== terminal.rows)
        return 'Normal logical viewport differs from measured native geometry'
      if (!Number.isSafeInteger(base) || base < 0) return 'Normal root anchor was lost'
      if (!Number.isSafeInteger(frame.columns) || !Number.isSafeInteger(frame.rows) ||
          frame.columns < 1 || frame.columns > terminal.cols || frame.rows < 0 ||
          !Array.isArray(frame.cells)) return 'Malformed normal logical frame geometry'
      if (buffer.cursorX !== frame.cursor?.x || buffer.cursorY !== base + frame.cursor?.y - buffer.baseY)
        return `cursor ${buffer.cursorX},${buffer.cursorY} != root(${base}) + ${frame.cursor?.x},${frame.cursor?.y} - baseY(${buffer.baseY})`
      const cells = new Map()
      for (const cell of frame.cells) {
        if (!Array.isArray(cell) || cell.length !== 5) return 'Malformed normal logical cell'
        const [x, y, char, width, ansi] = cell, key = `${x}:${y}`
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 ||
            x >= frame.columns || y >= frame.rows || typeof char !== 'string' ||
            ![0, 1, 2].includes(width) || typeof ansi !== 'string' || cells.has(key))
          return 'Malformed or duplicate normal logical cell'
        cells.set(key, { char: char || (width === 0 ? '' : ' '), width, ansi })
      }
      const height = Math.max(frame.rows, current.previousRows)
      for (let y = 0; y < height; y++) {
        const line = buffer.getLine(base + y)
        if (!line) return `Missing physical root row ${base + y}`
        for (let x = 0; x < terminal.cols; x++) {
          const cell = line.getCell(x), wanted = cells.get(`${x}:${y}`) ?? { char: ' ', width: 1, ansi: '' }
          if (!cell) return `Missing physical cell ${x},${base + y}`
          const actual = cell.getChars() || (cell.getWidth() === 0 ? '' : ' ')
          if (actual !== wanted.char || cell.getWidth() !== wanted.width)
            return `cell ${x},${y}: ${JSON.stringify(wanted)} != ${JSON.stringify({ char: actual, width: cell.getWidth() })}`
          const lead = cells.get(`${x - 1}:${y}`), ansi = wanted.width === 0 && lead?.width === 2 ? lead.ansi : wanted.ansi
          if (!samePaintedStyle(style(cell), await wantedStyle(ansi), wanted.char, wanted.width))
            return `cell ${x},${y} style differs`
        }
      }
      current.previousRows = frame.rows
      return undefined
    },
    dispose() { clear(); for (const observer of observers) observer.dispose() },
  }
}
