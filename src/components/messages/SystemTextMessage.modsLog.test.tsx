import {expect,test} from 'bun:test'
import React from 'react'
import {PassThrough,Writable} from 'node:stream'
import {render} from '../../ink.js'
import {SystemTextMessage} from './SystemTextMessage.js'
import {createSystemMessage} from '../../utils/messages.js'

test('plugin notice stays visible and dim without a status dot while ordinary info stays hidden', async () => {
  const stdin = new PassThrough()
  const chunks: string[]=[]
  const stdout = new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done()}})
  Object.assign(stdout,{columns:100,rows:24,isTTY:false})
  Object.assign(stdin,{isTTY:false,setRawMode(){},ref(){},unref(){}})
  let notice:React.ReactElement, warning:React.ReactElement
  function Probe() {
    notice=SystemTextMessage({message:createSystemMessage('logger: VISIBLE-PLUGIN-LOG','notice'),addMargin:false,verbose:false}) as React.ReactElement
    warning=SystemTextMessage({message:createSystemMessage('VISIBLE-WARNING','warning'),addMargin:false,verbose:false}) as React.ReactElement
    return <>
    {notice}
    <SystemTextMessage message={createSystemMessage('HIDDEN-INFO','info')} addMargin={false} verbose={false}/>
    {warning}
    </>
  }
  const instance=await render(<Probe/>,{stdin:stdin as never,stdout:stdout as never,patchConsole:false,exitOnCtrlC:false})
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    const frame=chunks.join('')
    expect(frame).toContain('logger: VISIBLE-PLUGIN-LOG')
    expect(frame).not.toContain('HIDDEN-INFO')
    expect(frame).toContain('VISIBLE-WARNING')
    const inner=(notice!.props as {children:React.ReactElement}).children
    expect(inner.props).toMatchObject({dot:false,dimColor:true})
    expect((warning!.props as {children:React.ReactElement}).children.props).toMatchObject({dot:true,dimColor:false,color:'warning'})
  } finally {instance.unmount();instance.cleanup();stdin.destroy();stdout.destroy()}
})
