import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyEditToFile,
  getPatchForEdits,
} from '../tools/FileEditTool/utils.js'
import { writeTextContent } from '../utils/file.js'
import { readFileSyncWithMetadata } from '../utils/fileRead.js'
import { computeEditsFromContents, savedContents } from './useDiffInIDE.js'

// What the IDE diff turns `old` into `new` for, byte for byte: the UTF-8 BOM
// and the final newline stay as they were.
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const fixtures = [
  { name: 'plain', bom: false, eol: false },
  { name: 'final newline', bom: false, eol: true },
  { name: 'BOM', bom: true, eol: false },
  { name: 'BOM and final newline', bom: true, eol: true },
]
const bytes = (word: string, bom: boolean, eol: boolean) =>
  Buffer.concat([
    bom ? BOM : Buffer.alloc(0),
    Buffer.from(word + (eol ? '\n' : '')),
  ])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ide-diff-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Runs one tool call through the diff: the proposed file goes to the IDE, its
 * answer comes back as edits, and the tool's own mapping writes them.
 */
function roundTrip(
  tool: 'Write' | 'Edit',
  how: 'accept' | 'save',
  bom: boolean,
  eol: boolean,
): Buffer {
  const file = join(dir, 'f.txt')
  writeFileSync(file, bytes('old', bom, eol))
  const {
    content: oldContent,
    encoding,
    lineEndings,
  } = readFileSyncWithMetadata(file)
  const proposed =
    tool === 'Write' ? bytes('new', bom, eol).toString('utf8') : undefined
  const edits =
    tool === 'Write'
      ? [{ old_string: oldContent, new_string: proposed!, replace_all: false }]
      : [{ old_string: 'old', new_string: 'new', replace_all: false }]
  const { updatedFile } = getPatchForEdits({
    filePath: file,
    fileContents: oldContent,
    edits,
  })
  // VS Code's document text never carries the BOM; that is the file's encoding.
  const newContent =
    how === 'accept'
      ? updatedFile
      : savedContents(updatedFile, updatedFile.replace(/^\uFEFF/, ''))
  const [edit] = computeEditsFromContents(
    file,
    oldContent,
    newContent,
    'single',
  )
  if (tool === 'Write') writeTextContent(file, edit!.new_string, encoding, 'LF')
  else
    writeTextContent(
      file,
      applyEditToFile(oldContent, edit!.old_string, edit!.new_string),
      encoding,
      lineEndings,
    )
  return readFileSync(file)
}

describe('IDE diff keeps the BOM and the final newline', () => {
  for (const tool of ['Write', 'Edit'] as const) {
    for (const how of ['accept', 'save'] as const) {
      for (const { name, bom, eol } of fixtures) {
        test(`${tool}, ${how}: ${name}`, () => {
          expect(roundTrip(tool, how, bom, eol).toString('hex')).toBe(
            bytes('new', bom, eol).toString('hex'),
          )
        })
      }
    }
  }

  test('an edit in the middle of a file leaves the lines around it alone', () => {
    const oldContent = 'a\nold\nb\n'
    const [edit] = computeEditsFromContents(
      'f.txt',
      oldContent,
      'a\nnew\nb\n',
      'single',
    )
    expect(
      applyEditToFile(oldContent, edit!.old_string, edit!.new_string),
    ).toBe('a\nnew\nb\n')
  })

  test('removing or adding the final newline in the editor is kept', () => {
    const [dropped] = computeEditsFromContents(
      'f.txt',
      'a\nold\n',
      'a\nold',
      'single',
    )
    expect(
      applyEditToFile('a\nold\n', dropped!.old_string, dropped!.new_string),
    ).toBe('a\nold')
    const [added] = computeEditsFromContents(
      'f.txt',
      'a\nold',
      'a\nold\n',
      'single',
    )
    expect(
      applyEditToFile('a\nold', added!.old_string, added!.new_string),
    ).toBe('a\nold\n')
  })
})
