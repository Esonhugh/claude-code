import { expect, test } from 'bun:test'
import { isAssistantNarrationSummary } from './assistantNarration.js'

function field(tag: number, bytes: number[]): number[] { return [tag * 8 + 2, bytes.length, ...bytes] }
const text = (kind: string) => [...new TextEncoder().encode(kind)]
const signature = (bytes: number[]) => Buffer.from(bytes).toString('base64')
const leaf = field(8, text('narration'))
const valid = field(2, field(1, leaf))
const wrap = (bytes: number[]) => field(2, field(1, bytes))
const block = (bytes: number[]) => ({ type: 'thinking', thinking: 'SUMMARY', signature: signature(bytes) })

test.each([
 ['nested narration',valid,true],
 ['wrong kind',wrap(field(8,text('summary'))),false],
 ['wrong case',wrap(field(8,text('Narration'))),false],
 ['BOM is kept',wrap(field(8,text('\ufeffnarration'))),false],
 ['wrong outer field',field(3,field(1,leaf)),false],
 ['wrong inner field',field(2,field(2,leaf)),false],
 ['wrong leaf field',wrap(field(7,text('narration'))),false],
 ['last leaf wins true',wrap([...field(8,text('private')),...leaf]),true],
 ['last leaf wins false',wrap([...leaf,...field(8,text('private'))]),false],
 ['last envelope wins false',[...valid,...field(2,field(1,field(8,text('private'))))],false],
 ['last metadata wins false',field(2,[...field(1,leaf),...field(1,field(8,text('private')))]),false],
 ['unknown varint/fixed fields skipped',wrap([8,150,1,25,...Array(8).fill(0),37,0,0,0,0,...leaf]),true],
 ['malformed tail invalidates earlier selection',[...valid,128],false],
 ['malformed inner tail',field(2,[...field(1,leaf),128]),false],
 ['malformed leaf tail',wrap([...leaf,128]),false],
 ['unsupported wire group',wrap([...leaf,11]),false],
 ['truncated fixed64',wrap([...leaf,25,0]),false],
 ['truncated fixed32',wrap([...leaf,37,0]),false],
 ['truncated length',wrap([66,20,1]),false],
 ['overlong varint',wrap([8,...Array(10).fill(128),0,...leaf]),false],
 ['invalid UTF8',wrap(field(8,[0xff,0xfe])),false],
 ['empty envelope',[],false],
])('signature display classification: %s',(_name,bytes,expected)=>{
 expect(isAssistantNarrationSummary(block(bytes))).toBe(expected)
})

test('invalid base64, a text block, missing signature and blank narration remain outside summary rendering',()=>{
 for(const value of ['?', 'narration', '', '===='])expect(isAssistantNarrationSummary({type:'thinking',thinking:'body',signature:value})).toBe(false)
 expect(isAssistantNarrationSummary({...block(valid),type:'text'})).toBe(false)
 expect(isAssistantNarrationSummary({...block(valid),thinking:' \n '})).toBe(false)
 expect(isAssistantNarrationSummary({type:'thinking',thinking:'body'})).toBe(false)
})

test('classification follows immutable block identity, while unsigned streaming blocks can acquire a signature',()=>{
 const cached=block(valid);expect(isAssistantNarrationSummary(cached)).toBe(true)
 cached.signature=signature(wrap(field(8,text('private'))));expect(isAssistantNarrationSummary(cached)).toBe(true)
 const pending={type:'thinking',thinking:'body',signature:''};expect(isAssistantNarrationSummary(pending)).toBe(false)
 pending.signature=signature(valid);expect(isAssistantNarrationSummary(pending)).toBe(true)
})
