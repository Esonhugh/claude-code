import {expect, test} from 'bun:test'
import {dispatchModEvent, getModCapabilitySignal} from './dispatch.js'
import type {ModNext} from './types.js'

test('normal completion expires next while its started operation still follows a later real parent cancellation',async()=>{
  const parent=new AbortController();let captured:ModNext
  await dispatchModEvent({event:'tool.call',input:{},signal:parent.signal,hooks:[{
    plugin:'normal',tier:'user',registration:{id:1,event:'tool.call',hasCatch:false},
    invoke:async(e,next)=>{captured=next;return next(e)},
  }],core:async()=>({result:'done'})})
  expect(captured!.signal.aborted).toBe(true)
  expect(getModCapabilitySignal(captured!).aborted).toBe(false)
  await expect(captured!({})).rejects.toThrow()
  parent.abort(Error('later real cancellation'))
  expect(getModCapabilitySignal(captured!).aborted).toBe(true)
  expect(getModCapabilitySignal(captured!).reason).toBe(parent.signal.reason)
})

test('timeout and throw abort the failed operation; a successful catch keeps a separate signal',async()=>{
  for(const mode of ['timeout','throw'] as const){
    let failed:ModNext,recovered:ModNext
    const result=await dispatchModEvent({event:'tool.call',input:{},budgetMs:5,catchGraceMs:50,hooks:[{
      plugin:mode,tier:'user',registration:{id:1,event:'tool.call',hasCatch:true},
      invoke:async(e,next,catching)=>{
        if(catching){recovered=next;return next(e)}
        failed=next
        if(mode==='throw')throw Error('explicit failure')
        return new Promise(()=>{})
      },
    }],core:async()=>({result:'recovered'})})
    expect(result).toEqual({result:'recovered'})
    expect(getModCapabilitySignal(failed!).aborted).toBe(true)
    expect(failed!.signal.aborted).toBe(true)
    expect(recovered!.signal.aborted).toBe(true)
    expect(getModCapabilitySignal(recovered!).aborted).toBe(false)
  }
})
