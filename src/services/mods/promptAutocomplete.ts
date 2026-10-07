import { sanitizePromptFillInput } from './promptFillUnicode.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isDeepStrictEqual } from 'node:util'
import type { PromptBox } from './promptAdapter.js'
import type { ModInput } from './types.js'

export type PromptAutocompleteInput = PromptBox & {token:string;start:number}
export type PromptAutocompleteSuggestion = {text:string;label?:string;description?:string}
export type PromptAutocompleteResult = {suggestions:readonly PromptAutocompleteSuggestion[]}
const facts=['text','cursor','token','start'] as const
export function promptAutocompleteToken(box:PromptBox):PromptAutocompleteInput|undefined{
 const cursor=Math.max(0,Math.min(box.cursor,box.text.length));let start=cursor
 while(start>0&&box.text.charAt(start-1).trim()!=='')start--
 return start===cursor?undefined:{text:box.text,cursor,token:box.text.slice(start,cursor),start}
}
export function restorePromptAutocompleteInput(input:ModInput,received:ModInput):ModInput{
 const result={...input};for(const key of facts)if(!Object.hasOwn(result,key)&&Object.hasOwn(received,key))result[key]=received[key]
 return result
}
export function validatePromptAutocompleteInput(input:ModInput,received:ModInput):void{
 for(const key of facts)if(!isDeepStrictEqual(input[key],received[key]))throw new TypeError(`prompt.autocomplete cannot rewrite ${key}`)
}
export function validatePromptAutocompleteResult(value:unknown):asserts value is PromptAutocompleteResult{
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray((value as PromptAutocompleteResult).suggestions))throw new TypeError('prompt.autocomplete must return suggestions')
 for(const row of (value as PromptAutocompleteResult).suggestions){
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.text!=='string'||row.text===''||row.label!==undefined&&typeof row.label!=='string'||row.description!==undefined&&typeof row.description!=='string')throw new TypeError('prompt.autocomplete suggestions require text and optional label/description strings')
 }
}
export function normalizePromptAutocompleteRows(rows:readonly PromptAutocompleteSuggestion[]):PromptAutocompleteSuggestion[]{
 const enabled=getFeatureValue_CACHED_MAY_BE_STALE('tengu_tranquil_cloud',true)
 return rows.flatMap(({text:raw,label,description})=>{
  const text=sanitizePromptFillInput({text:raw},enabled).text
  if(text==='')return []
  const line=label?.replace(/\s+/gu,' ').trim()
  return [{text,...(line?{label:line}:{}),...(description===undefined?{}:{description})}]
 })
}
