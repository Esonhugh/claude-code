import { test, expect } from 'bun:test'
import { verifyNativeInputEvents, verifyNativeChildInputReads } from './terminal-input-evidence.mjs'

const fixture = (query, input) => {
  const raw = Buffer.from(query)
  return { raw, io: [
    { ioId: 1, kind: 'output', start: 0, end: raw.length, rawOffset: raw.length },
    ...input.map((hex, index) =>
      ({ ioId: index + 2, kind: 'input', hex, rawOffset: raw.length })),
  ] }
}
test('actual parsed terminal replies preserve exact ordered UTF-8 driver bytes across reads', async () => {
  const intended = Buffer.from('中文\r')
  const reply = Buffer.from('\x1bP>|tmux 3.6b\x1b\\\x1b[?1;2;4c')
  const data = Buffer.concat([reply, intended])
  const { raw, io } = fixture('\x1b[>q\x1b[c',
    [data.subarray(0, 3).toString('hex'), data.subarray(3, 21).toString('hex'),
     data.subarray(21).toString('hex')])
  const proof = await verifyNativeInputEvents(raw, io, intended)
  expect(proof.verdict).toBe('passed')
  expect(proof.terminalReplies.map(row => row.kind)).toEqual(['version', 'primary-attributes'])
  expect(proof.driverBytes).toBe(intended.length)
  expect(proof.nativeBytes).toBe(data.length)
})
test('a terminal-shaped escape string needs a prior real parsed query', async () => {
  const intended = Buffer.from('x'), reply = Buffer.from('\x1b[?1;2;4cx')
  for (const query of ['', '\x1b]0;title [c\x07', '\x1b[>q']) {
    const { raw, io } = fixture(query, [reply.toString('hex')])
    await expect(verifyNativeInputEvents(raw, io, intended)).rejects.toThrow('differs')
  }
})
test('dropped, repeated and extra driver input cannot be repaired by terminal reply classification', async () => {
  for (const data of ['x', 'xxx', 'xy']) {
    const { raw, io } = fixture('', [Buffer.from(data).toString('hex')])
    await expect(verifyNativeInputEvents(raw, io, Buffer.from('xx'))).rejects.toThrow('differs')
  }
})

test('actual child reads preserve /exit and CR around a real interleaved tmux response', async () => {
  const intended = Buffer.from('/exit\r')
  const chunks = [Buffer.from('\x1bP>|tmux 3.6b\x1b\\/exit'),
    Buffer.from('\x1b[?1;2;4c'), Buffer.from('\r')]
  const { raw, io } = fixture('\x1b[>q\x1b[c', chunks.map(bytes => bytes.toString('hex')))
  const proof = await verifyNativeChildInputReads(raw, io, intended, chunks)
  expect(proof.verdict).toBe('passed')
  expect(proof.childReadBytes).toBe(30)
  expect(proof.driverBytes).toBe(intended.length)
  expect(proof.childReadSHA256).toBe(proof.nativeInputSHA256)
  expect(proof.terminalReplies.map(row => row.kind)).toEqual(['version', 'primary-attributes'])
  expect(proof.actualInputOwnerCovered).toBe(false)
})
test('child read grouping may differ while every original broker byte remains required', async () => {
  const data = Buffer.from('/exit\r')
  const { raw, io } = fixture('', [data.toString('hex')])
  expect((await verifyNativeChildInputReads(raw, io, data, [data.subarray(0, 3), data.subarray(3)])).verdict).toBe('passed')
  for (const prefixes of [[data.subarray(1)], [data, Buffer.from('x')], [Buffer.from('/exiT\r')]]) {
    await expect(verifyNativeChildInputReads(raw, io, data, prefixes)).rejects.toThrow('child read bytes')
  }
})
test('interleaved terminal-shaped input without its actual output query is rejected', async () => {
  const chunks = [Buffer.from('/exit'), Buffer.from('\x1b[?1;2;4c'), Buffer.from('\r')]
  const { raw, io } = fixture('', chunks.map(bytes => bytes.toString('hex')))
  await expect(verifyNativeChildInputReads(raw, io, Buffer.from('/exit\r'), chunks)).rejects.toThrow('differs')
})
