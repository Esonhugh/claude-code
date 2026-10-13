import {expect, test} from 'bun:test'
import {createModPromptEditQueue, promptEditSplice} from './promptEdit.js'
import type {PromptEditResult} from './promptEdit.js'
import type {PromptBox} from './promptAdapter.js'
import type {TextInputEdit} from '../../types/textInputTypes.js'

function fixture(box: PromptBox) {
  const jobs: (() => void)[] = [], raised: TextInputEdit[] = [], reports: string[] = [], paints: unknown[] = []
  const gates: ReturnType<typeof Promise.withResolvers<PromptEditResult>>[] = []
  const queue = createModPromptEditQueue({
    read: () => box, commit: next => {box = next}, report: reason => reports.push(reason),
    paint: (...args) => paints.push(args), later: job => jobs.push(job),
    raise: edit => {raised.push(edit); const gate = Promise.withResolvers<PromptEditResult>(); gates.push(gate); return gate.promise},
  })
  return {queue, jobs, raised, reports, paints, gates, read: () => box, set: (next: PromptBox) => {box = next}}
}

test('UTF-16 splice uses before and after cursor and retains cursor-only moves', () => {
  expect(promptEditSplice({text:'a😀b',cursor:3}, {text:'a😀Xb',cursor:4})).toEqual({start:3,end:3,inputText:'X'})
  expect(promptEditSplice({text:'a😀b',cursor:3}, {text:'a😀b',cursor:1})).toEqual({start:1,end:1,inputText:''})
  expect(promptEditSplice({text:'abcd',cursor:3}, {text:'acd',cursor:1})).toEqual({start:1,end:2,inputText:''})
})

test('one microtask burst has one before and final after with no invented key, and one live chain', async () => {
  const f = fixture({text:'ab',cursor:2})
  f.queue.record({before:{text:'',cursor:0},after:{text:'a',cursor:1},key:{key:'a'}})
  f.queue.record({before:{text:'a',cursor:1},after:{text:'ab',cursor:2},key:{key:'b'}})
  expect(f.jobs).toHaveLength(1)
  f.jobs.shift()!()
  expect(f.raised).toEqual([{before:{text:'',cursor:0},after:{text:'ab',cursor:2}}])
  f.queue.record({before:f.read(),after:{text:'abc',cursor:3},key:{key:'c'}})
  f.set({text:'abc',cursor:3})
  expect(f.raised).toHaveLength(1)
  f.gates[0]!.resolve({text:'ab',cursor:2})
  await Promise.resolve()
  expect(f.raised[1]).toEqual({before:{text:'ab',cursor:2},after:{text:'abc',cursor:3},key:{key:'c'}})
  f.gates[1]!.resolve(f.read()); await Promise.resolve(); f.queue.dispose()
})

test('late rewrite keeps nonoverlapping person input and caret rather than replacing the pending draft', async () => {
  const f = fixture({text:'abcd',cursor:2})
  f.queue.record({before:{text:'acd',cursor:1},after:f.read()}); f.jobs.shift()!()
  f.set({text:'abcdX',cursor:5})
  f.gates[0]!.resolve({text:'aBcd',cursor:2}); await Promise.resolve()
  expect(f.read()).toEqual({text:'aBcdX',cursor:5})
  expect(f.reports).toEqual([]); expect(f.paints).toEqual([]); f.queue.dispose()
})

test('conflicting late rewrite keeps the actual draft and cannot paint stale decorations', async () => {
  const f = fixture({text:'abcd',cursor:2})
  f.queue.record({before:{text:'acd',cursor:1},after:f.read()}); f.jobs.shift()!()
  f.set({text:'aQcd',cursor:2})
  f.gates[0]!.resolve({text:'aBcd',cursor:2,decorations:[{start:1,end:2,bold:true}]}); await Promise.resolve()
  expect(f.read()).toEqual({text:'aQcd',cursor:2})
  expect(f.reports).toEqual(["prompt.edit: a rewrite no longer fits the draft (it moved meanwhile); the person's typing stands"])
  expect(f.paints).toEqual([]); f.queue.dispose()
})

test('an answer clamps the caret and only paints its own text, while disposal blocks late commit', async () => {
  const f = fixture({text:'a',cursor:1})
  f.queue.record({before:{text:'',cursor:0},after:f.read()}); f.jobs.shift()!()
  f.gates[0]!.resolve({text:'A',cursor:99,decorations:[{start:0,end:1,italic:true}]}); await Promise.resolve()
  expect(f.read()).toEqual({text:'A',cursor:1})
  expect(f.paints).toEqual([[[{start:0,end:1,italic:true}], 'A']])
  f.queue.record({before:f.read(),after:{text:'AB',cursor:2}}); f.set({text:'AB',cursor:2}); f.jobs.shift()!()
  f.queue.dispose(); f.gates[1]!.resolve({text:'late',cursor:4}); await Promise.resolve()
  expect(f.read()).toEqual({text:'AB',cursor:2})
  expect(f.paints).toHaveLength(1)
})
