import { expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React, { createRef } from 'react'
import { Box, Text, render } from '../../ink.js'
import instances from '../../ink/instances.js'
import { updateSelection } from '../../ink/selection.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { VirtualMessageList, type JumpHandle } from '../../components/VirtualMessageList.js'
import type { RenderableMessage } from '../../types/message.js'
import { createModUiSelectionTracker } from './uiSelection.js'

class Output extends Writable {
  columns = 40; rows = 8; isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {callback()}
}
async function screen(node: React.ReactNode) {
  const output=new Output(), stdout=output as unknown as NodeJS.WriteStream
  const rendered=await render(node,{stdout,patchConsole:false,exitOnCtrlC:false})
  const ink=instances.get(stdout)!
  ink.setAltScreenActive(true);rendered.rerender(node)
  await new Promise(resolve=>setTimeout(resolve,40))
  return {ink,rendered}
}
test('real Ink take-down keeps selection through its consuming run and expires after a later run',async()=>{
  const {ink,rendered}=await screen(<Text>alpha beta</Text>)
  const tracker=createModUiSelectionTracker(()=>ink,()=>undefined), disconnect=tracker.connect()
  try{
    ink.startTextSelection(0,0);updateSelection(ink.selection,4,0)
    const alreadyRunning=tracker.beginRun()
    ink.clearTextSelection()
    expect(tracker.read()).toEqual({text:'alpha'})
    tracker.endRun(alreadyRunning)
    expect(tracker.read()).toEqual({text:'alpha'})
    const consuming=tracker.beginRun()
    expect(tracker.read()).toEqual({text:'alpha'})
    tracker.endRun(consuming)
    expect(tracker.read()).toBeUndefined()
    ink.startTextSelection(6,0);updateSelection(ink.selection,9,0)
    ink.clearTextSelection()
    expect(tracker.read()).toEqual({text:'beta'})
    ink.clearTextSelection()
    expect(tracker.read()).toEqual({text:'beta'})
    tracker.endRun(tracker.beginRun())
    expect(tracker.read()).toBeUndefined()
  }finally{disconnect();rendered.unmount()}
})
test('actual transcript row identity uses tool ids, excludes other scroll scopes and multi-row selections',async()=>{
  const scroll=createRef<ScrollBoxHandle>(),pane=createRef<ScrollBoxHandle>(),jump=createRef<JumpHandle>()
  const messages=[
    {type:'user',uuid:'user-uuid',message:{role:'user',content:[{type:'text',text:'user'}]}},
    {type:'assistant',uuid:'assistant-uuid',message:{content:[{type:'tool_use',id:'tool-use-actual',name:'Read',input:{}}]}},
    {type:'user',uuid:'result-uuid',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-use-actual',content:'result'}]}},
  ] as unknown as RenderableMessage[]
  const node=<Box flexDirection="row" width={40} height={5}>
    <ScrollBox ref={scroll} width={20} height={5} flexDirection="column">
      <VirtualMessageList messages={messages} scrollRef={scroll} columns={20} jumpRef={jump} itemKey={m=>m.uuid} renderItem={(_,i)=><Text>{['user text','tool text','result text'][i]}</Text>}/>
    </ScrollBox>
    <ScrollBox ref={pane} width={20} height={5}><Text>pane text</Text></ScrollBox>
  </Box>
  const {ink,rendered}=await screen(node)
  const tracker=createModUiSelectionTracker(()=>ink,s=>jump.current?.rowHoldingSelection?.(s)),disconnect=tracker.connect()
  try{
    const top=scroll.current!.getViewportTop()
    ink.startTextSelection(0,top);updateSelection(ink.selection,3,top)
    expect(tracker.read()).toEqual({text:'user',requestId:'user-uuid'})
    ink.startTextSelection(0,top+1);updateSelection(ink.selection,3,top+1)
    expect(tracker.read()).toEqual({text:'tool',requestId:'tool-use-actual'})
    ink.startTextSelection(0,top+2);updateSelection(ink.selection,5,top+2)
    expect(tracker.read()).toEqual({text:'result',requestId:'tool-use-actual'})
    ink.startTextSelection(20,top);updateSelection(ink.selection,23,top)
    expect(tracker.read()).toEqual({text:'pane'})
    ink.startTextSelection(0,top);updateSelection(ink.selection,3,top+1)
    expect(tracker.read()?.requestId).toBeUndefined()
    ink.selection.virtualAnchorRow=top-1
    expect(tracker.read()?.requestId).toBeUndefined()
  }finally{disconnect();rendered.unmount()}
})

test('real Ink copy keeps the taken-down selection for the next input exactly like official 289', async () => {
  const previousSsh = process.env.SSH_CONNECTION
  process.env.SSH_CONNECTION = 'private-fixture'
  const {ink,rendered} = await screen(<Text>alpha beta</Text>)
  const tracker = createModUiSelectionTracker(() => ink, () => undefined), disconnect = tracker.connect()
  try {
    ink.startTextSelection(0,0); updateSelection(ink.selection,4,0)
    expect(ink.copySelection()).toBe('alpha')
    expect(ink.hasTextSelection()).toBe(false)
    expect(tracker.read()).toEqual({text:'alpha'})
    ink.clearTextSelection()
    expect(tracker.read()).toEqual({text:'alpha'})
    const input = tracker.beginRun()
    expect(tracker.read()).toEqual({text:'alpha'})
    tracker.endRun(input)
    expect(tracker.read()).toBeUndefined()
  } finally {
    disconnect(); rendered.unmount()
    if (previousSsh === undefined) delete process.env.SSH_CONNECTION
    else process.env.SSH_CONNECTION = previousSsh
  }
})
