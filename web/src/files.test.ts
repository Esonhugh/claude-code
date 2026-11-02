import { describe, expect, it } from 'bun:test'
import { localFileSrc } from './markdown/safeUrl'
import { mentionPath, parseCsv, previewKind, splitMentions } from './files'
import { userMessage } from './protocol'

describe('files', () => {
  it('picks a viewer by extension and falls back to text', () => {
    expect(previewKind('/a/report.PDF')).toBe('pdf')
    expect(previewKind('/a/deck.pptx')).toBe('office')
    expect(previewKind('/a/data.tsv')).toBe('csv')
    expect(previewKind('/a/Makefile')).toBe('text')
    expect(previewKind('/a/archive.zip')).toBe('binary')
  })

  it('parses quoted CSV fields and stops at the row limit', () => {
    expect(parseCsv('a,"b,""c"""\r\n"x\ny",z').rows).toEqual([
      ['a', 'b,"c"'],
      ['x\ny', 'z'],
    ])
    const many = parseCsv('1\n2\n3\n4\n', ',', 2)
    expect(many).toEqual({ rows: [['1'], ['2']], truncated: true })
  })

  it('round-trips @ mentions with spaces and quotes', () => {
    const path = '/tmp/up/my "file" (1).txt'
    const text = `see ${mentionPath(path)} and @/etc/x.md, not a@/b`
    expect(splitMentions(text)).toEqual([
      { text: 'see ' },
      { path },
      { text: ' and ' },
      { path: '/etc/x.md,' },
      { text: ' not a@/b' },
    ])
  })

  it('maps local image paths onto the file API only', () => {
    const base = '/api/files/s1'
    expect(localFileSrc('/tmp/a b.png', base)).toBe('/api/files/s1?path=%2Ftmp%2Fa%20b.png')
    expect(localFileSrc('file:///tmp/a.png', base)).toBe('/api/files/s1?path=%2Ftmp%2Fa.png')
    expect(localFileSrc('https://x/a.png', base)).toBe('https://x/a.png')
    expect(localFileSrc('//evil/a.png', base)).toBe('//evil/a.png')
    expect(localFileSrc('/tmp/a.png', undefined)).toBe('/tmp/a.png')
  })

  it('sends attached images as base64 image blocks before the text', () => {
    const msg = userMessage('look', ['data:image/png;base64,AAAA', 'javascript:x']) as {
      message: { content: unknown[] }
    }
    expect(msg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'look' },
    ])
  })
})
