import { expect, test } from 'bun:test'
import * as prompt from './promptEdit.js'
import { C_e, VHo } from './fixtures/promptDecorations289.mjs'

test('prompt decorations clamp UTF-16 ranges and snap both edges to whole graphemes', () => {
  expect(typeof prompt.normalizePromptDecorations).toBe('function')
  expect(prompt.normalizePromptDecorations([{start:-5,end:2,bold:true},{start:2,end:4,italic:true},{start:4,end:99,underline:true}], 'a😀b')).toEqual([
    {start:0,end:1,bold:true}, {start:1,end:4,italic:true}, {start:4,end:4,underline:true},
  ].filter(run => run.start < run.end))
})

test('decoration ranges and edit migration agree with the original pure official 289 functions', () => {
  const texts = ['abc', 'a😀b', 'e\u0301中', '👨‍👩‍👧‍👦x']
  for (const text of texts) for (const start of [-2, 0, 1, 2, text.length]) for (const end of [0, 1, 2, text.length, text.length + 5]) {
    const runs=[{start,end,color:'red',bold:true},{start:1,end:text.length,bold:false,underline:true}]
    expect(prompt.normalizePromptDecorations(runs,text)).toEqual(Array.from(C_e(runs,text)))
  }
  const before={text:'a😀b',cursor:3},after={text:'a😀Xb',cursor:4},runs=[{start:1,end:3,italic:true},{start:3,end:4,color:'blue'}]
  expect(prompt.carryPromptDecorations(runs,before,after)).toEqual(Array.from(C_e(VHo(runs,prompt.promptEditSplice(before,after)),after.text)))
})

test('overlapping decorations combine by property, retain false and coalesce equal adjacent runs', () => {
  expect(typeof prompt.normalizePromptDecorations).toBe('function')
  expect(prompt.normalizePromptDecorations([{start:0,end:4,color:'red',bold:true},{start:1,end:3,italic:true,bold:false},{start:3,end:4,italic:true}], 'abcd')).toEqual([
    {start:0,end:1,color:'#e5484d',bold:true}, {start:1,end:3,color:'#e5484d',bold:false,italic:true}, {start:3,end:4,color:'#e5484d',bold:true,italic:true},
  ])
  expect(prompt.normalizePromptDecorations([{start:0,end:1,color:'red'},{start:1,end:3,color:'#e5484d'}], 'abc')).toEqual([{start:0,end:3,color:'#e5484d'}])
})

test('person edits carry existing decorations across insertions and erase ranges that were replaced', () => {
  expect(typeof prompt.carryPromptDecorations).toBe('function')
  const paint=[{start:1,end:3,bold:true}]
  expect(prompt.carryPromptDecorations(paint,{text:'abcd',cursor:1},{text:'aXbcd',cursor:2})).toEqual([{start:2,end:4,bold:true}])
  expect(prompt.carryPromptDecorations(paint,{text:'abcd',cursor:2},{text:'abXcd',cursor:3})).toEqual([{start:1,end:4,bold:true}])
  expect(prompt.carryPromptDecorations(paint,{text:'abcd',cursor:3},{text:'aQd',cursor:2})).toEqual([])
})
