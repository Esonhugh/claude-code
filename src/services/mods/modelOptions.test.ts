import { expect, test } from 'bun:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createModModelComplete } from './modelAdapter.js'
import type { SideQueryOptions } from '../../utils/sideQuery.js'

const response = { content: [{type:'text',text:'ok'}], usage: {input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4} }

test.each(['low','medium','high','xhigh','max'] as const)('completion forwards supported effort %s without session defaults', async effort => {
  const calls: SideQueryOptions[] = []
  const complete = createModModelComplete(async input => {calls.push(input);return response}, () => 'claude-sonnet-4-6', () => 64000)
  await complete({model:'sonnet',prompt:'data',effort})
  expect(calls[0]?.effort).toBe(effort)
})

test('completion drops effort where the resolved model does not support it', async () => {
  const calls: SideQueryOptions[] = []
  const complete = createModModelComplete(async input => {calls.push(input);return response}, () => 'claude-haiku-4-5', () => 64000)
  await complete({model:'haiku',prompt:'data',effort:'max'})
  expect(calls[0]).not.toHaveProperty('effort')
})

test.each(['none','minimal','ultra','ultracode','wrong',null])('completion refuses invalid effort %s before transport', async effort => {
  let calls=0
  const complete=createModModelComplete(async () => {calls++;return response}, model => model, () => 64000)
  await expect(complete({model:'haiku',prompt:'data',effort} as never)).rejects.toThrow('effort')
  expect(calls).toBe(0)
})

test.each([0,-1,1.5,NaN,Infinity,null])('completion refuses invalid timeout %s before transport', async timeoutMs => {
  let calls=0
  const complete=createModModelComplete(async () => {calls++;return response}, model => model, () => 64000)
  await expect(complete({model:'haiku',prompt:'data',timeoutMs} as never)).rejects.toThrow('timeoutMs')
  expect(calls).toBe(0)
})

test('completion timeout resolves aborted even if transport ignores cancellation', async () => {
  let signal: AbortSignal | undefined
  const complete=createModModelComplete(async options => {signal=options.signal;return await new Promise(() => {})}, model => model, () => 64000)
  expect(await complete({model:'haiku',prompt:'data',timeoutMs:10})).toEqual({isAnswered:false,reason:'aborted',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}})
  expect(signal?.aborted).toBe(true)
})

test('completion clears its deadline after success', async () => {
  let signal: AbortSignal | undefined
  const complete=createModModelComplete(async options => {signal=options.signal;return response}, model => model, () => 64000)
  expect((await complete({model:'haiku',prompt:'data',timeoutMs:10})).isAnswered).toBe(true)
  await delay(25)
  expect(signal?.aborted).toBe(false)
})

test('completion accepts large positive timeout values with a clamped deadline', async () => {
  let calls=0
  const complete=createModModelComplete(async () => {calls++;return response}, model => model, () => 64000)
  expect((await complete({model:'haiku',prompt:'data',timeoutMs:2147483648})).isAnswered).toBe(true)
  expect(calls).toBe(1)
})
