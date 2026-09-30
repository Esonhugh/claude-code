import { readFileSync, writeFileSync } from 'node:fs'
import * as xtermHeadless from '@xterm/headless'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('Usage: verify-terminal-frame-evidence.mjs INPUT.jsonl OUTPUT.json')
}

const Terminal =
  xtermHeadless.Terminal ??
  xtermHeadless.default?.Terminal ??
  xtermHeadless['module.exports']?.Terminal
if (!Terminal) throw new Error('Unable to load @xterm/headless Terminal export')

function writeSync(terminal, text) {
  const writeBuffer = terminal._core?._writeBuffer
  if (writeBuffer) writeBuffer.writeSync(text)
  else terminal.write(text)
}

function decodeFrame(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
}

function terminalCellStyle(cell) {
  return [
    cell?.getFgColorMode() ?? 0,
    cell?.getFgColor() ?? 0,
    cell?.getBgColorMode() ?? 0,
    cell?.getBgColor() ?? 0,
    cell?.isBold() ?? false,
    cell?.isDim() ?? false,
    cell?.isItalic() ?? false,
    cell?.isUnderline() ?? false,
    cell?.isInverse() ?? false,
    cell?.isInvisible() ?? false,
    cell?.isStrikethrough() ?? false,
    cell?.isOverline() ?? false,
  ].join(':')
}

function styleFromAnsi(Terminal, ansi) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: 2,
    rows: 1,
    convertEol: true,
    logLevel: 'off',
  })
  try {
    writeSync(terminal, `${ansi}X`)
    const cell = terminal.buffer.active.getLine(0)?.getCell(0)
    return terminalCellStyle(cell)
  } finally {
    terminal.dispose()
  }
}

function screenLines(frame) {
  const cells = new Map(
    frame.cells.map(([x, y, char, width]) => [`${x}:${y}`, { char, width }]),
  )
  const lines = []
  for (let y = 0; y < frame.rows; y++) {
    let line = ''
    for (let x = 0; x < frame.columns; x++) {
      const cell = cells.get(`${x}:${y}`)
      if (cell?.width === 0) continue
      line += cell?.char || ' '
    }
    lines.push(line.trimEnd())
  }
  return lines
}

function semanticEvidence(text) {
  const rendered = text.join('\n')
  const diffMode = rendered.includes('Diff · detail')
    ? 'detail'
    : rendered.includes('Diff · files') ||
        (text.some(line => /(?:^|│)\s*Diff\s*(?:✕)?\s*$/.test(line)) &&
          rendered.includes('Base:') && rendered.includes('Source:'))
      ? 'files'
      : null
  if (!diffMode) {
    return {
      diffMode: null,
      alphaBody: false,
      omegaBody: false,
      loading: false,
      alphaFile: false,
      omegaFile: false,
    }
  }
  return {
    diffMode,
    alphaBody: rendered.includes('ALPHA_RELEASE_BODY') || rendered.includes('ALPHA_BODY'),
    omegaBody: rendered.includes('OMEGA_RELEASE_BODY') || rendered.includes('OMEGA_BODY'),
    loading:
      rendered.includes('Loading diff…') ||
      rendered.includes('Refreshing diff…') ||
      rendered.includes('Loading diff body…'),
    alphaFile: rendered.includes('alpha.txt') || rendered.includes('alpha.ts'),
    omegaFile: rendered.includes('omega.txt') || rendered.includes('omega.ts'),
  }
}

function frameDifference(frame, terminal, Terminal) {
  const buffer = terminal.buffer.active
  if (terminal.cols !== frame.columns || terminal.rows !== frame.rows) {
    return `dimensions ${frame.columns}x${frame.rows} !== ${terminal.cols}x${terminal.rows}`
  }
  const expectedBuffer = frame.buffer ?? 'alternate'
  const actualBuffer = buffer.type === 'alternate' ? 'alternate' : 'normal'
  if (actualBuffer !== expectedBuffer) {
    return `buffer ${actualBuffer} !== ${expectedBuffer}`
  }
  if (
    expectedBuffer === 'alternate' &&
    (buffer.baseY !== 0 || buffer.viewportY !== 0)
  ) {
    return `viewport baseY=${buffer.baseY} viewportY=${buffer.viewportY}`
  }
  if (buffer.cursorX !== frame.cursor.x || buffer.cursorY !== frame.cursor.y) {
    return `cursor ${frame.cursor.x},${frame.cursor.y} !== ${buffer.cursorX},${buffer.cursorY}`
  }
  const styleCache = new Map()
  const expected = new Map()
  for (const [x, y, char, width, style = ''] of frame.cells) {
    let normalizedStyle = styleCache.get(style)
    if (normalizedStyle === undefined) {
      normalizedStyle = styleFromAnsi(Terminal, style)
      styleCache.set(style, normalizedStyle)
    }
    const lead = expected.get(`${x - 1}:${y}`)
    if (width === 0 && lead?.width === 2) normalizedStyle = lead.style
    expected.set(`${x}:${y}`, { char, width, style: normalizedStyle })
  }
  const defaultStyle = styleFromAnsi(Terminal, '')
  const reusable = buffer.getNullCell()
  for (let y = 0; y < frame.rows; y++) {
    const line = buffer.getLine(y)
    for (let x = 0; x < frame.columns; x++) {
      const cell = line?.getCell(x, reusable)
      const actual = {
        char: cell?.getChars() || (cell?.getWidth() === 0 ? '' : ' '),
        width: cell?.getWidth() ?? 1,
        style: terminalCellStyle(cell),
      }
      const wanted = expected.get(`${x}:${y}`) ?? {
        char: ' ',
        width: 1,
        style: defaultStyle,
      }
      if (actual.char !== wanted.char || actual.width !== wanted.width) {
        return `cell ${x},${y}: ${JSON.stringify(wanted)} !== ${JSON.stringify(actual)}`
      }
      if (actual.style !== wanted.style) {
        return `cell ${x},${y} style: ${JSON.stringify(wanted.style)} !== ${JSON.stringify(actual.style)}`
      }
    }
  }
  return undefined
}

const entries = readFileSync(inputPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line))
if (!entries.length) throw new Error('No terminal frame evidence was recorded')

let terminal
const frames = []
try {
  for (const entry of entries) {
    const frame = decodeFrame(entry.frameBase64)
    if (!terminal) {
      terminal = new Terminal({
        allowProposedApi: true,
        cols: frame.columns,
        rows: frame.rows,
        convertEol: true,
        logLevel: 'off',
      })
    } else if (terminal.cols !== frame.columns || terminal.rows !== frame.rows) {
      terminal.resize(frame.columns, frame.rows)
    }
    const output = Buffer.from(entry.outputBase64, 'base64')
    writeSync(terminal, output.toString('utf8'))
    const difference = frameDifference(frame, terminal, Terminal)
    const text = screenLines(frame)
    frames.push({
      frameId: entry.frameId,
      columns: frame.columns,
      rows: frame.rows,
      outputBytes: output.length,
      verdict: difference ? 'failed' : 'passed',
      difference,
      text,
      semantic: semanticEvidence(text),
    })
  }
} finally {
  terminal?.dispose()
}

const sizeSequence = []
for (const frame of frames) {
  const previous = sizeSequence.at(-1)
  if (previous?.columns === frame.columns && previous.rows === frame.rows) continue
  sizeSequence.push({
    columns: frame.columns,
    rows: frame.rows,
    frameId: frame.frameId,
  })
}

const report = {
  input: inputPath,
  frameCount: frames.length,
  outputBytes: frames.reduce((total, frame) => total + frame.outputBytes, 0),
  verdict: frames.every(frame => frame.verdict === 'passed') ? 'passed' : 'failed',
  sizeSequence,
  frames,
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
if (report.verdict !== 'passed') process.exitCode = 1
