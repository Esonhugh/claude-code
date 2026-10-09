import { expect, test } from 'bun:test'
import React, { useLayoutEffect, useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { render, Text, useInput, useStdin } from '../../ink.js'
import type { PointerEvent } from '../events/pointer-event.js'

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const a = '\x1b[97u', b = '\x1b[98u'

async function mountCounter() {
  const stdin = new Input(), stdout = new Output()
  const reads: { kind: string; input: string; count: number; pasted?: true }[] = []
  let committed = 0
  function Probe() {
    const [count, setCount] = useState(0)
    const { internal_eventEmitter: emitter } = useStdin()
    useLayoutEffect(() => { committed = count }, [count])
    useInput((input, _key, event) => {
      reads.push({ kind: 'key', input, count, ...(event.keypress.isPasted ? { pasted: true as const } : {}) })
      setCount(previous => previous + 1)
    })
    useLayoutEffect(() => {
      const pointer = (event: PointerEvent) => {
        reads.push({ kind: 'pointer', input: event.type, count })
        setCount(previous => previous + 1)
        event.stopImmediatePropagation()
      }
      const blur = () => { setCount(previous => previous + 1) }
      emitter.on('pointer', pointer); emitter.on('terminalblur', blur)
      return () => { emitter.removeListener('pointer', pointer); emitter.removeListener('terminalblur', blur) }
    }, [count, emitter])
    return <Text>{count}</Text>
  }
  const instance = await render(<Probe />, {stdin:stdin as never,stdout:stdout as never,patchConsole:false,exitOnCtrlC:false})
  await settle()
  return { reads, get committed(){return committed}, async send(chunk:string){stdin.push(chunk);await settle()}, close(){instance.unmount();instance.cleanup()} }
}

test('real App commits between semantic keys so the next actual useInput consumer observes current props',async()=>{
  const h=await mountCounter()
  try {
    await h.send(a+b)
    expect(h.reads).toEqual([{kind:'key',input:'a',count:0},{kind:'key',input:'b',count:1}])
    expect(h.committed).toBe(2)
  }finally{h.close()}
})
test('a single ordinary text token stays one event and one editor update',async()=>{
  const h=await mountCounter()
  try { await h.send('abc');expect(h.reads).toEqual([{kind:'key',input:'abc',count:0}]);expect(h.committed).toBe(1) }
  finally{h.close()}
})
test('one bracketed paste retains embedded control bytes and commits before the following semantic key',async()=>{
  const h=await mountCounter(),text='a\r\t\x1b[27u'
  try {
    await h.send('\x1b[200~'+text+'\x1b[201~'+b)
    expect(h.reads).toEqual([{kind:'key',input:text,count:0,pasted:true},{kind:'key',input:'b',count:1}])
    expect(h.committed).toBe(2)
  }finally{h.close()}
})
test('wheel followed by a single ordinary key stays outside the multiple-semantic-input threshold',async()=>{
  const h=await mountCounter()
  try {
    await h.send('\x1b[<64;3;5M'+a)
    expect(h.reads.map(event=>event.count)).toEqual([0,0])
    expect(h.reads.map(event=>event.input)).toEqual(['','a'])
    expect(h.committed).toBe(2)
  }finally{h.close()}
})
test.each([0,32])('actual mouse button %i has the official click versus motion commit qualification',async button=>{
  const h=await mountCounter()
  try {
    await h.send('\x1b[<'+button+';3;5M'+a)
    expect(h.reads.map(event=>event.count)).toEqual([0,button===0?1:0])
    expect(h.reads.at(-1)).toEqual({kind:'key',input:'a',count:button===0?1:0})
    expect(h.committed).toBe(2)
  }finally{h.close()}
})
test('terminal focus transition commits before the following actual key consumer',async()=>{
  const h=await mountCounter()
  try {await h.send('\x1b[O'+a);expect(h.reads).toEqual([{kind:'key',input:'a',count:1}]);expect(h.committed).toBe(2)}
  finally{h.close()}
})
test('terminal response never becomes editor input or changes the semantic count',async()=>{
  const h=await mountCounter()
  try {await h.send('\x1b[?25;1$y'+a);expect(h.reads).toEqual([{kind:'key',input:'a',count:0}]);expect(h.committed).toBe(1)}
  finally{h.close()}
})
test('a burst beyond React nested-update depth commits each semantic event without re-entry failure',async()=>{
  const h=await mountCounter()
  try {
    await h.send(a.repeat(100))
    expect(h.reads).toHaveLength(100)
    expect(h.reads.map(event=>event.count)).toEqual(Array.from({length:100},(_,i)=>i))
    expect(h.committed).toBe(100)
  }finally{h.close()}
})
