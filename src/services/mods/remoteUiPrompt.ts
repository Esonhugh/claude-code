import { logForDebugging } from '../../utils/debug.js'
import type { TextInputEdit } from '../../types/textInputTypes.js'
import type { SDKControlUIPromptEditRequest,SDKControlUIPromptEditResponse,SDKControlUIPromptAutocompleteRequest,SDKControlUIPromptAutocompleteResponse } from '../../entrypoints/sdk/modsControlTypes.js'
import { normalizePromptDecorations,promptEditSplice,type PromptEditResult } from './promptEdit.js'
import { normalizePromptAutocompleteRows,promptAutocompleteToken,type PromptAutocompleteInput,type PromptAutocompleteResult } from './promptAutocomplete.js'
import type { PromptBox } from './promptAdapter.js'

type Edit={box:PromptBox;key?:TextInputEdit['key'];answer(value:SDKControlUIPromptEditResponse):void}
type Draft={box:PromptBox;offered?:PromptBox;raising:boolean;stale:boolean;waiting:Edit[]}
type Ask={box:PromptBox;answer(value:SDKControlUIPromptAutocompleteResponse):void}
type Completion={out?:AbortController;waiting?:Ask}
const boxOf=(box:PromptBox):PromptBox=>({text:box.text,cursor:Math.max(0,Math.min(box.cursor,box.text.length))})
const clientOf=(request:{client_id?:string;surface?:string})=>request.client_id??`${request.surface??'desktop'}:default`
function changed(before:PromptBox,after:PromptBox){const edit=promptEditSplice(before,after);return edit.end-edit.start+edit.inputText.length}
/** A remote composer owns its draft. Hooks answer edits; they do not write it. */
export function createModRemotePrompt(options:{edit(edit:TextInputEdit):Promise<PromptEditResult>;autocomplete(input:PromptAutocompleteInput,signal:AbortSignal):Promise<PromptAutocompleteResult>}){
 const drafts=new Map<string,Draft>(),completions=new Map<string,Completion>()
 function draft(client:string){const state=drafts.get(client)??{box:{text:'',cursor:0},raising:false,stale:false,waiting:[]};drafts.delete(client);drafts.set(client,state);return state}
 function flush(state:Draft){
  const latest=state.waiting.at(-1);if(state.raising||!latest)return
  const key=state.waiting.length===1?latest.key:undefined
  const before=state.offered&&changed(state.offered,latest.box)<changed(state.box,latest.box)?state.offered:state.box
  for(const old of state.waiting.slice(0,-1))old.answer({...old.box,superseded:true})
  state.box=latest.box;state.offered=undefined;state.waiting=[];state.raising=true
  const settle=(result:PromptEditResult)=>{
   const box=boxOf(result),offered=(box.text!==latest.box.text||box.cursor!==latest.box.cursor)&&!state.waiting.length&&!state.stale
   const decorations=normalizePromptDecorations(result.decorations,box.text)
   state.raising=false;state.stale=false;if(offered)state.offered=box
   latest.answer({...box,...(decorations.length?{decorations}:{})});flush(state)
  }
  new Promise<PromptEditResult>(resolve=>resolve(options.edit({before,after:latest.box,...(key===undefined?{}:{key})}))).then(settle,error=>{
   logForDebugging(`prompt.edit (remote composer): ${error instanceof Error?error.message:String(error)}; the edit stands`);settle(latest.box)
  })
 }
 function stopCompletion(state:Completion|undefined){state?.out?.abort();state?.waiting?.answer({suggestions:[],superseded:true});if(state)state.waiting=undefined}
 function complete(client:string,state:Completion){
  const ask=state.waiting
  if(!state.out&&!ask&&completions.get(client)===state)completions.delete(client)
  if(state.out||!ask){state.out?.abort();return}
  const input=promptAutocompleteToken(ask.box);state.waiting=undefined
  if(!input){ask.answer({suggestions:[]});complete(client,state);return}
  const controller=new AbortController();state.out=controller
  new Promise<PromptAutocompleteResult>(resolve=>resolve(options.autocomplete(input,controller.signal)))
   .then(result=>normalizePromptAutocompleteRows(result.suggestions),error=>{
    if(!controller.signal.aborted)logForDebugging(`prompt.autocomplete (remote composer): ${error instanceof Error?error.message:String(error)}; no row added`)
    return []
   }).then(suggestions=>{
    state.out=undefined;ask.answer(controller.signal.aborted?{suggestions:[],superseded:true}:{suggestions,start:input.start});complete(client,state)
   })
 }
 return {
  edit(request:SDKControlUIPromptEditRequest):Promise<SDKControlUIPromptEditResponse>{
   const client=clientOf(request),state=draft(client),box=boxOf(request)
   logForDebugging(`[ModsRemotePrompt] edit client=${client} by=${request.by??'person'} length=${box.text.length} cursor=${box.cursor}`)
   if(request.by==='app'){
    for(const pending of state.waiting)pending.answer({...pending.box,superseded:true})
    state.box=box;state.offered=undefined;state.waiting=[];state.stale=state.raising;return Promise.resolve(box)
   }
   return new Promise(answer=>{state.waiting.push({box,...(request.key===undefined?{}:{key:request.key}),answer});flush(state)})
  },
  autocomplete(request:SDKControlUIPromptAutocompleteRequest):Promise<SDKControlUIPromptAutocompleteResponse>{
   const client=clientOf(request)
   return new Promise(answer=>{const state=completions.get(client)??{};completions.set(client,state);state.waiting?.answer({suggestions:[],superseded:true});state.waiting={box:boxOf(request),answer};complete(client,state)})
  },
  read():PromptBox|undefined{return [...drafts.values()].at(-1)?.box},
  forget(client:string){drafts.delete(client);stopCompletion(completions.get(client));completions.delete(client)},
  clear(){drafts.clear();for(const state of completions.values())stopCompletion(state);completions.clear()},
 }
}
