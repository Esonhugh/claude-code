import { expect, test } from 'bun:test'
import {
  collectResultBlocks,
  movedBytesText,
  REPL_BLOCK_RESULT_TEXT_CHARS,
  resultBlockContent,
  scriptValue,
} from './resultBlocks.js'

const image = (base64: string, type = 'image/png') => ({ type: 'image', file: { base64, type, originalSize: 1 } })
const pdf = (base64: string) => ({ type: 'pdf', file: { filePath: 'a.pdf', base64, originalSize: 1 } })
const read = (value: unknown, phase = 'complete') => ({ toolName: 'Read', phase, value })

test('the placeholder is official `mr`', () => {
  expect(movedBytesText('abcd', 'image')).toBe(
    '[4 base64 chars — image bytes moved to the REPL result, subject to its per-result image cap]',
  )
  expect(movedBytesText('ab', 'document')).toBe(
    '[2 base64 chars — document bytes moved to the REPL result, subject to its per-result document cap]',
  )
})

test('scripts see placeholders for Read images, PDFs and pages, and for MCP images', () => {
  expect(scriptValue({ toolName: 'Read' }, image('abcd'))).toEqual({
    ...image('abcd'),
    file: { ...image('abcd').file, base64: movedBytesText('abcd', 'image') },
  })
  expect(scriptValue({ toolName: 'Read' }, pdf('xyz'))).toMatchObject({ file: { base64: movedBytesText('xyz', 'document') } })
  const parts = { type: 'parts', pages: [{ base64: 'pp', mediaType: 'image/jpeg' }, { error: 'bad' }] }
  expect(scriptValue({ toolName: 'Read' }, parts)).toEqual({
    type: 'parts',
    pages: [{ base64: movedBytesText('pp', 'image'), mediaType: 'image/jpeg' }, { error: 'bad' }],
  })
  const mcp = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'mm' } }, { type: 'text', text: 't' }]
  expect(scriptValue({ toolName: 'mcp__s__t', mcpContent: true }, mcp)).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: movedBytesText('mm', 'image') } },
    { type: 'text', text: 't' },
  ])
  // Untouched: another tool, an image without a media type, an MCP image type the API does not take.
  expect(scriptValue({ toolName: 'Other' }, image('abcd'))).toEqual(image('abcd'))
  const untyped = { type: 'image', file: { base64: 'abcd' } }
  expect(scriptValue({ toolName: 'Read' }, untyped)).toBe(untyped)
  const bmp = [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'mm' } }]
  expect(scriptValue({ toolName: 'mcp__s__t', mcpContent: true }, bmp)).toBe(bmp)
})

test('finished calls hand over at most 8 images and 4 documents, counting the rest', () => {
  const calls = [
    ...Array.from({ length: 6 }, (_, i) => read(image(`i${i}`))),
    read(image('running')),
    { toolName: 'Read', phase: 'start', value: image('started') },
    read({ type: 'parts', pages: [{ base64: 'p1', mediaType: 'image/jpeg' }, { base64: 'p2', mediaType: 'image/jpeg' }, { base64: 'p3', mediaType: 'image/jpeg' }] }),
    { toolName: 'mcp__s__t', phase: 'complete', mcpContent: true, value: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'g' } }] },
    ...Array.from({ length: 5 }, (_, i) => read(pdf(`d${i}`))),
  ]
  const blocks = collectResultBlocks(calls)
  expect(blocks.images?.map(i => i.base64)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'running', 'p1'])
  expect(blocks.imagesOmitted).toBe(3)
  expect(blocks.documents).toEqual([{ base64: 'd0' }, { base64: 'd1' }, { base64: 'd2' }, { base64: 'd3' }])
  expect(blocks.documentsOmitted).toBe(1)
  expect(collectResultBlocks([read({ type: 'text', file: { content: 'x' } })])).toEqual({})
})

test('the tool_result puts the text first, then images, the image note, documents and the document note', () => {
  const content = resultBlockContent('<repl-output/>', {
    images: [{ base64: 'i', mediaType: 'image/png' }],
    imagesOmitted: 2,
    documents: [{ base64: 'd' }],
    documentsOmitted: 1,
  })
  expect(content).toEqual([
    { type: 'text', text: '<repl-output/>' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'i' } },
    {
      type: 'text',
      text: '[2 more image(s) from inner tool calls not shown — a REPL result carries at most 8 images; fetch fewer images or PDF pages per REPL call]',
    },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'd' } },
    {
      type: 'text',
      text: '[1 more PDF document(s) from inner Read calls not shown — a REPL result surfaces at most 4 documents; read fewer PDFs per call]',
    },
  ])
  expect(resultBlockContent('x', {})).toBeUndefined()
  expect(resultBlockContent('', { documents: [{ base64: 'd' }] })?.[0]).toEqual({ type: 'text', text: '(no text output)' })
  const long = 'a'.repeat(REPL_BLOCK_RESULT_TEXT_CHARS + 5)
  expect(resultBlockContent(long, { images: [{ base64: 'i', mediaType: 'image/png' }] })?.[0]).toEqual({
    type: 'text',
    text: `${'a'.repeat(REPL_BLOCK_RESULT_TEXT_CHARS)}\n[… 5 more chars truncated — block-bearing REPL results are capped at 100000 chars of text]`,
  })
})
