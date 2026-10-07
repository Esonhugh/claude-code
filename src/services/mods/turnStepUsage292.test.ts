import {expect,test} from 'bun:test'
import {streamModTurnStep} from './turnStepAdapter.js'
import {createModHookStream} from './dispatch.js'
const usage={input_tokens:1,output_tokens:0,cache_read_input_tokens:3,cache_creation_input_tokens:4}
test.each([false,true])('turn.step preserves partial SSE usage unless the Mod changes it (%s)',async rewrite=>{
 const input={turnId:'owned',index:0,model:'owned-model',messageCount:1}
 const snapshot={stream:(_event:unknown,e:any,core:any)=>createModHookStream((async function*(){const source=core(e);for await(const chunk of source)yield rewrite&&chunk.kind==='stop'?{...chunk,usage:{...chunk.usage,input_tokens:19}}:chunk;return await source.return(undefined)})())} as never
 const out=[];for await(const item of streamModTurnStep(snapshot,input,async function*(){yield {type:'stream_event',event:{type:'message_start',message:{id:'owned',type:'message',role:'assistant',model:'owned-model',content:[],usage,stop_reason:null,stop_sequence:null}}} as never;yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}}} as never;yield {type:'stream_event',event:{type:'message_stop'}} as never},new AbortController().signal))out.push(item)
 const delta=out.find(item=>item.type==='stream_event'&&item.event.type==='message_delta') as any
 expect(delta.event.usage).toEqual(rewrite?{...usage,output_tokens:2,input_tokens:19,model:'owned-model'}:{output_tokens:2})
})
