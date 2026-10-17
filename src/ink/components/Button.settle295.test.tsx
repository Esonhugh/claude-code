import { expect, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import render from '../root.js'
import type { DOMElement } from '../dom.js'
import type { EventHandlerProps } from '../events/event-handlers.js'
import Button from './Button.js'
import Text from './Text.js'
import { ClockContext } from './ClockContext.js'
import { ClickEvent } from '../events/click-event.js'
import { KeyboardEvent } from '../events/keyboard-event.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../parse-keypress.js'

test('mounted Button protects clicks for 299ms, permits 300ms and immediate keyboard, and preserves mount time on redraw', async()=>{
  let time=0,calls=0,element:DOMElement|null=null
  const clock={now:()=>time,subscribe:()=>()=>{},setTickInterval:()=>{},setTimeout:()=>()=>{}}
  const stdout=Object.assign(new Writable({write(_chunk,_encoding,done){done()}}),{columns:80,rows:24,isTTY:false})
  const stdin=Object.assign(new Readable({read(){}}),{isTTY:true,isRaw:false,setRawMode(){return this},ref(){return this},unref(){return this}})
  const tree=(label:string)=><ClockContext.Provider value={clock}><Button ref={value=>{element=value}} onAction={()=>{calls++}}><Text>{label}</Text></Button></ClockContext.Provider>
  const instance=await render(tree('Save'),{stdout:stdout as unknown as NodeJS.WriteStream,stdin:stdin as unknown as NodeJS.ReadStream,patchConsole:false,exitOnCtrlC:false})
  try{
    expect(element).not.toBeNull()
    const handlers=()=>element!._eventHandlers! as EventHandlerProps
    const click=(activation=false)=>{
      const event=new ClickEvent(0,0,false,undefined,activation)
      handlers().onClick!(event)
      return event
    }
    const [keys]=parseMultipleKeypresses(INITIAL_STATE,'\r')
    if(keys[0]!.kind!=='key')throw Error('Expected a real parsed key')
    handlers().onKeyDown!(new KeyboardEvent(keys[0]!))
    expect(calls).toBe(1)
    calls=0
    time=299
    expect(click().droppedAsStray).toBe(true)
    expect(calls).toBe(0)
    time=300
    expect(click().droppedAsStray).toBe(false)
    expect(calls).toBe(1)
    expect(click(true).droppedAsStray).toBe(true)
    expect(calls).toBe(1)
    instance.rerender(tree('Save again'))
    expect(click().droppedAsStray).toBe(false)
    expect(calls).toBe(2)
  }finally{instance.unmount();instance.cleanup()}
})
