import {afterEach,beforeEach,expect,test} from 'bun:test'
import stripAnsi from 'strip-ansi'
import {ColorDiff,ColorFile} from './index.js'

let previousColorTerm:string|undefined
beforeEach(()=>{previousColorTerm=process.env.COLORTERM;delete process.env.COLORTERM})
afterEach(()=>{if(previousColorTerm===undefined)delete process.env.COLORTERM;else process.env.COLORTERM=previousColorTerm})

// Captured from official 2.1.291 /diff at 160x40, dark theme, xterm-256color.
// The removed line stays plain; the added line retains syntax and word colours.
const hunk={oldStart:1,oldLines:2,newStart:1,newLines:3,lines:[
  "-export const greeting = 'before';",'-export const count = 1;',
  "+export const greeting = 'after';",'+export const count = 2;',"+export const added = 'new';",' ',
]}
const foreground=(index:number,text:string)=>new RegExp('\\x1b\\[38;5;'+index+'m(?:\\x1b\\[[0-9;]*m)*'+text)

test('TypeScript diff keeps the official syntax and word foregrounds using the installed highlighter',()=>{
  const lines=new ColorDiff(hunk,null,'alpha.ts',null).render('dark',70,false)!
  expect(lines.map(stripAnsi)).toEqual([
    " 1 -export const greeting = 'before';",' 2 -export const count = 1;',
    " 1 +export const greeting = 'after';",' 2 +export const count = 2;'," 3 +export const added = 'new';",
  ].map(line=>line.padEnd(70)).concat(' 4  '))
  expect(lines[0]).not.toMatch(foreground(197,'export'))
  expect(lines[2]).toMatch(foreground(197,'export'))
  expect(lines[2]).toMatch(foreground(81,'const'))
  expect(lines[2]).toMatch(foreground(186,"'"))
  expect(lines[2]).toContain('\x1b[48;5;28mafter')
  expect(lines[3]).toMatch(foreground(141,'2'))
})

test('Code source shares a valid token tree and preserves text in dark and light themes',()=>{
  for(const theme of ['dark','light']){
    const lines=new ColorFile('export const answer = 42;','answer.ts').render(theme,80,false)!
    expect(lines.map(stripAnsi).join('\n')).toContain('export const answer = 42;')
    const colours=new Set(lines.join('\n').split('\x1b[38;5;').slice(1).map(part=>part.split('m')[0]))
    expect(colours.size).toBeGreaterThan(2)
    expect(lines.join('\n')).not.toContain('[object Object]')
  }
})

test('unknown extensions retain plain code and stable hunk gutters',()=>{
  const lines=new ColorDiff(hunk,null,'alpha.unknown-language',null).render('dark',70,false)!
  expect(lines[2]).not.toMatch(foreground(197,'export'))
  expect(stripAnsi(lines[2]!)).toContain(" 1 +export const greeting = 'after';")
})
