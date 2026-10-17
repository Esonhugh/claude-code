import {expect,test} from 'bun:test'
import * as highlights from './textHighlighting.js'
import {getTheme, THEME_NAMES} from './theme.js'
import officialThemes from '../services/mods/fixtures/promptThemes289.json'
import {PMr} from '../services/mods/fixtures/promptHighlights289.mjs'
import type {TextHighlight} from './textHighlighting.js'
import type {PromptDecoration} from '../services/mods/promptEdit.js'

test('plugin paint merges by style onto resolved base spans and valid foreground stops shimmer',()=>{
 expect(typeof highlights.mergePromptDecorations).toBe('function')
 const base=[{start:0,end:4,color:'warning' as const,bold:true,shimmerColor:'warningShimmer' as const,priority:5}]
 expect(highlights.mergePromptDecorations(base,[{start:1,end:3,color:'#123456',bold:false,italic:true}],getTheme('dark'))).toEqual([
  {...base[0],start:0,end:1},{...base[0],start:1,end:3,color:'#123456',shimmerColor:undefined,bold:false,italic:true},{...base[0],start:3,end:4},
 ])
})

test('invalid plugin color cannot erase a base color or shimmer, while false remains a style',()=>{
 expect(typeof highlights.mergePromptDecorations).toBe('function')
 const base=[{start:0,end:2,color:'warning' as const,dimColor:true,shimmerColor:'warningShimmer' as const,priority:5}]
 expect(highlights.mergePromptDecorations(base,[{start:0,end:2,color:'constructor',backgroundColor:'#broken',dimColor:false}],getTheme('dark'))).toEqual([{...base[0],dimColor:false}])
})

test('cursor protection keeps dim baseline and discards ordinary baseline at the caret',()=>{
 expect(typeof highlights.mergePromptDecorations).toBe('function')
 const base=[{start:0,end:4,color:'warning' as const,dimColor:true,priority:5}]
 expect(highlights.mergePromptDecorations(base,[{start:0,end:4,color:'#123456',bold:true}],getTheme('dark'),{start:1,end:3})).toEqual([
  {...base[0],start:0,end:1,color:'#123456',shimmerColor:undefined,bold:true},{...base[0],start:1,end:3},{...base[0],start:3,end:4,color:'#123456',shimmerColor:undefined,bold:true},
 ])
 const ordinary=[{...base[0],dimColor:false}]
 expect(highlights.mergePromptDecorations(ordinary,[{start:0,end:4,bold:true}],getTheme('dark'),{start:1,end:3})).toEqual([
  {start:0,end:1,color:undefined,priority:0,bold:true},{start:3,end:4,color:undefined,priority:0,bold:true},
 ])
})


test('merged paint and cursor spans equal original pure official 289 PMr output',()=>{
 const base:TextHighlight[][]=[[],[{start:0,end:4,color:'warning',priority:5}], [{start:0,end:4,color:'suggestion',dimColor:true,priority:10}], [{start:0,end:3,color:'warning',shimmerColor:'warningShimmer',priority:5},{start:1,end:4,color:'error',priority:20}]]
 const paint:PromptDecoration[][]=[[],[{start:1,end:3,color:'warning',bold:false}], [{start:0,end:4,color:'#123456',backgroundColor:'ansi:red',dimColor:false,bold:true}], [{start:0,end:4,color:'constructor',backgroundColor:'#broken',underline:true}], [{start:1,end:2,italic:true},{start:2,end:4,color:'rgb(1,2,3)',strikethrough:true}]]
 for(const a of base)for(const b of paint)for(const cursor of [undefined,{start:1,end:3},{start:4,end:5}]){
  expect(highlights.mergePromptDecorations(a,b,getTheme('dark'),cursor)).toEqual(PMr(a,b,cursor))
 }
})


test('all six public theme palettes and decoration keys equal the pinned official 289 contract',()=>{
 for(const name of THEME_NAMES){
  const theme=getTheme(name)
  const official=officialThemes.themes[name]
  expect(Object.keys(official)).toHaveLength(72)
  for(const [key,value] of Object.entries(official)){
   expect((theme as unknown as Record<string,string>)[key]?.replace(/\s/g,'')).toBe(value.replace(/\s/g,''))
   const paint=[{start:0,end:1,color:key,backgroundColor:key}]
   expect(highlights.mergePromptDecorations([],paint,theme)).toEqual(PMr([],paint))
  }
  for(const key of ['messageActionsBackground','constructor','unknownShortColor']){
   const paint=[{start:0,end:1,color:key,backgroundColor:key}]
   expect(highlights.mergePromptDecorations([],paint,theme)).toEqual(PMr([],paint))
  }
 }
})
