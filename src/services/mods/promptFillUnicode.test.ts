import {expect,test} from 'bun:test'
import {sanitizePromptFillInput,promptFillUTF16Map} from './promptFillUnicode.js'
import {createOfficial289Fixture} from './fixtures/promptUnicode289.mjs'
const official=createOfficial289Fixture({wellFormed:'fallback'})
const texts=['ASCII\t\n','A\u200B😀\r\nB\uD800C','\r\n\n','\v\f\x85\u2028\u2029','👩🏽‍💻','👨‍👩‍👧‍👦','می\u200Cروم','क्\u200Dष','ก\u200Bข','a\u200Db','a\uFE0F','中\u{E0100}','\uD800x\uDC00','ⒶＡ①ée\u0301','\uE000\u0378','🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}','🏴\u{E0062}\u{E0061}\u{E0064}\u{E007F}']
test('typed cleaner and UTF16 remap preserve exact official language, emoji, newline, surrogate and span behavior',()=>{
 for(const text of texts){const runs=[{start:-1,end:100,bold:true},{start:1,end:2,bold:false},{start:2,end:4,color:'red'},{start:3.5,end:99,italic:true}]
  const before=structuredClone(runs),expected=official.Xit(text,runs),actual=sanitizePromptFillInput({text,decorations:runs,mode:'replace' as const})
  expect(actual.text).toBe(expected.text);expect(actual.decorations).toEqual(expected.decorations)
  expect(Array.from(promptFillUTF16Map(text,actual.text))).toEqual(Array.from(official.Yit(text,expected.text)))
  expect(runs).toEqual(before)
 }
})
test('bounded deterministic corpus agrees with exact official algorithm for default-on and explicit pure false gate',()=>{
 const points=['a','ب','क','ก','😀','👩','🏽','💻','\u200B','\u200C','\u200D','\uFE0F','\u034F','\r','\n','\v','\x85','\uD800','\uDC00','\u{E0061}','\u{E007F}'];let seed=0x12345678
 const disabled=createOfficial289Fixture({payload:{tengu_tranquil_cloud:false},wellFormed:'fallback'})
 for(let item=0;item<512;item++){let text='';for(let i=0;i<9;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=points[seed%points.length]}
  const input={text,decorations:[{start:1,end:5,bold:true},{start:-2,end:100,color:'red'}],origin:{kind:'plugin',name:'owned'}}
  const got=sanitizePromptFillInput(input),expected=official.Xit(text,input.decorations)
  expect(got.text).toBe(expected.text);expect(got.decorations).toEqual(expected.decorations)
  expect(got.origin).toBe(input.origin)
  expect(sanitizePromptFillInput(input,false)).toBe(input)
  expect(disabled.Xit(text,input.decorations)).toEqual({text,decorations:input.decorations})
 }
})
test('undefined, empty arrays, unchanged text, and original shape are retained',()=>{
 const a={text:'ascii',extra:'owned'},b={text:'ascii',decorations:[]}
 expect(sanitizePromptFillInput(a)).toBe(a);expect(sanitizePromptFillInput(b)).toBe(b)
 expect(sanitizePromptFillInput({text:'\r'})).toEqual({text:'\n'})
 expect(sanitizePromptFillInput({text:'\r',decorations:[]})).toEqual({text:'\n',decorations:[]})
})
