import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const verifier = join(import.meta.dir, 'verify-terminal-frame-evidence.mjs')

function evidence(frame, output, frameId = 1) {
  return `${JSON.stringify({
    frameId,
    outputBase64: Buffer.from(output).toString('base64'),
    frameBase64: Buffer.from(JSON.stringify(frame)).toString('base64'),
  })}\n`
}

function runEntries(entries) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-frame-evidence-'))
  const input = join(root, 'frames.jsonl')
  const report = join(root, 'report.json')
  try {
    writeFileSync(
      input,
      entries
        .map(({ frame, output }, index) => evidence(frame, output, index + 1))
        .join(''),
    )
    const result = spawnSync(process.execPath, [verifier, input, report], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(readFileSync(report, 'utf8'))
    return { result, report: parsed }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function run(frame, output) {
  return runEntries([{ frame, output }])
}

function frameWithLines(columns, lines) {
  const rows = Math.max(2, lines.length)
  const cells = []
  for (let y = 0; y < rows; y++) {
    const chars = Array.from(lines[y] ?? '')
    for (let x = 0; x < columns; x++) {
      cells.push([x, y, chars[x] ?? ' ', 1])
    }
  }
  return {
    columns,
    rows,
    viewport: { width: columns, height: rows },
    cursor: {
      x: Array.from(lines.at(-1) ?? '').length,
      y: lines.length - 1,
      visible: true,
    },
    cells,
  }
}

function draw(lines, enterAlternateScreen = false) {
  return `${enterAlternateScreen ? '\u001b[?1049h' : ''}\u001b[2J\u001b[H${lines.join('\n')}`
}

const frame = {
  columns: 4,
  rows: 2,
  viewport: { width: 4, height: 2 },
  cursor: { x: 2, y: 0, visible: true },
  cells: [
    [0, 0, '中', 2],
    [1, 0, '', 0],
    [2, 0, ' ', 1],
    [3, 0, ' ', 1],
    [0, 1, ' ', 1],
    [1, 1, ' ', 1],
    [2, 1, ' ', 1],
    [3, 1, ' ', 1],
  ],
}

describe('terminal frame evidence verifier', () => {
  test('accepts matching alternate-screen cells, widths, and cursor', () => {
    const { result, report } = run(
      frame,
      '\u001b[?1049h\u001b[2J\u001b[H中',
    )

    expect(result.status).toBe(0)
    expect(report.verdict).toBe('passed')
    expect(report.frames[0].verdict).toBe('passed')
  })

  test('accepts matching normal-screen evidence', () => {
    const normalFrame = { ...frame, buffer: 'normal' }
    const { result, report } = run(normalFrame, '中')

    expect(result.status).toBe(0)
    expect(report.verdict).toBe('passed')
  })

  test('accepts terminal-inherited styling on a wide-cell continuation', () => {
    const styledFrame = {
      ...frame,
      cells: frame.cells.map(cell =>
        cell[0] === 0 && cell[1] === 0
          ? [...cell, '\u001b[31m']
          : cell,
      ),
    }
    const { result, report } = run(
      styledFrame,
      '\u001b[?1049h\u001b[2J\u001b[H\u001b[31m中',
    )

    expect(result.status).toBe(0)
    expect(report.verdict).toBe('passed')
  })

  test('fails when physical styling diverges from the logical frame', () => {
    const styledFrame = {
      ...frame,
      cells: frame.cells.map(cell =>
        cell[0] === 0 && cell[1] === 0
          ? [...cell, '']
          : cell,
      ),
    }
    const { result, report } = run(
      styledFrame,
      '\u001b[?1049h\u001b[2J\u001b[H\u001b[31m中',
    )

    expect(result.status).toBe(1)
    expect(report.verdict).toBe('failed')
    expect(report.frames[0].difference).toContain('style')
  })

  test('fails closed when physical output diverges from the logical frame', () => {
    const { result, report } = run(
      frame,
      '\u001b[?1049h\u001b[2J\u001b[H文',
    )

    expect(result.status).toBe(1)
    expect(report.verdict).toBe('failed')
    expect(report.frames[0].difference).toContain('cell 0,0')
  })

  test('reports semantic evidence and the collapsed 110 to 109 to 110 size sequence', () => {
    const states = [
      {
        columns: 110,
        lines: ['Diff · files', '› alpha.ts +1 -0', '  omega.ts +1 -0'],
      },
      {
        columns: 110,
        lines: ['Diff · detail', 'alpha.ts', 'Loading diff body…'],
      },
      {
        columns: 109,
        lines: ['Diff · detail', 'alpha.ts', '+ALPHA_BODY'],
      },
      {
        columns: 110,
        lines: ['Diff · detail', 'omega.ts', '+OMEGA_BODY'],
      },
    ]
    const { result, report } = runEntries(
      states.map(({ columns, lines }, index) => ({
        frame: frameWithLines(columns, lines),
        output: draw(lines, index === 0),
      })),
    )

    expect(result.status).toBe(0)
    expect(report.sizeSequence).toEqual([
      { columns: 110, rows: 3, frameId: 1 },
      { columns: 109, rows: 3, frameId: 3 },
      { columns: 110, rows: 3, frameId: 4 },
    ])
    expect(report.frames.map(({ text }) => text)).toEqual(
      states.map(({ lines }) => lines),
    )
    expect(report.frames.map(({ semantic }) => semantic)).toEqual([
      {
        diffMode: 'files',
        alphaBody: false,
        omegaBody: false,
        loading: false,
        alphaFile: true,
        omegaFile: true,
      },
      {
        diffMode: 'detail',
        alphaBody: false,
        omegaBody: false,
        loading: true,
        alphaFile: true,
        omegaFile: false,
      },
      {
        diffMode: 'detail',
        alphaBody: true,
        omegaBody: false,
        loading: false,
        alphaFile: true,
        omegaFile: false,
      },
      {
        diffMode: 'detail',
        alphaBody: false,
        omegaBody: true,
        loading: false,
        alphaFile: false,
        omegaFile: true,
      },
    ])
  })

  test('recognizes the binary driver sidebar and exact release fixture markers', () => {
    const lines = ['transcript │ Diff', '│ Base: session Source: Current',
      '│ alpha.txt omega.txt +ALPHA_RELEASE_BODY']
    const { result, report } = run(frameWithLines(110, lines), draw(lines, true))
    expect(result.status).toBe(0)
    expect(report.frames[0].semantic).toEqual({
      diffMode: 'files', alphaBody: true, omegaBody: false,
      loading: false, alphaFile: true, omegaFile: true,
    })
    const detail = ['Diff · detail', 'omega.txt', '+OMEGA_RELEASE_BODY']
    expect(run(frameWithLines(110, detail), draw(detail, true)).report.frames[0].semantic)
      .toEqual({diffMode: 'detail', alphaBody: false, omegaBody: true,
        loading: false, alphaFile: false, omegaFile: true})
  })

  test('does not treat matching non-diff marker text as semantic diff evidence', () => {
    const lines = [
      'shell output: alpha.ts omega.ts',
      'payload: ALPHA_BODY OMEGA_BODY',
    ]
    const { result, report } = run(frameWithLines(110, lines), draw(lines, true))

    expect(result.status).toBe(0)
    expect(report.frames[0].verdict).toBe('passed')
    expect(report.frames[0].semantic).toEqual({
      diffMode: null,
      alphaBody: false,
      omegaBody: false,
      loading: false,
      alphaFile: false,
      omegaFile: false,
    })
  })
})
