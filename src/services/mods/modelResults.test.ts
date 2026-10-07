import {afterEach,beforeEach, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { createModModelComplete, createModModelClassify } from './modelAdapter.js'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {resetSettingsCache} from '../../utils/settings/settingsCache.js'
const envKeys=['HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'] as const
let saved: (string|undefined)[], authRoot: string
beforeEach(async()=>{
  authRoot=await realpath(await mkdtemp(join(tmpdir(),'mods-model-result-')))
  saved=envKeys.map(key=>process.env[key])
  process.env.HOME=authRoot;process.env.CLAUDE_CONFIG_DIR=authRoot
  process.env.ANTHROPIC_API_KEY='sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  resetSettingsCache()
})
afterEach(async()=>{
  resetSettingsCache()
  envKeys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i]})
  await rm(authRoot,{recursive:true,force:true})
})
const zero = {input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}
const usage = {input_tokens:3,output_tokens:4,cache_read_input_tokens:5,cache_creation_input_tokens:6}
test('completion publishes answered text with the actual four usage counters', async () => {
  const complete = createModModelComplete(async () => ({content:[{type:'text',text:'one'},{type:'thinking'},{type:'text',text:'two'}],usage}), model => model)
  expect(await complete({model:'test',prompt:'hello'})).toEqual({isAnswered:true,text:'onetwo',usage})
})
test('empty reply is a structured failure that keeps response usage', async () => {
  const complete = createModModelComplete(async () => ({content:[{type:'thinking'}],usage}), model => model)
  expect(await complete({model:'test',prompt:'hello'})).toEqual({isAnswered:false,reason:'empty-reply',usage})
})
test('provider failure publishes only its status, category and zero usage', async () => {
  const complete = createModModelComplete(async () => {throw APIError.generate(429,{error:{type:'rate_limit_error',message:'FAKE_PRIVATE_BODY'}},'FAKE_PRIVATE_DETAIL',new Headers({'x-private':'FAKE_PRIVATE_HEADER'}))}, model => model)
  expect(await complete({model:'test',prompt:'hello'})).toEqual({isAnswered:false,reason:'api-error',status:429,error:'rate_limit',usage:zero})
})
test('already aborted completion resolves without submitting a provider request', async () => {
  let calls=0
  const complete = createModModelComplete(async () => {calls++;return {content:[{type:'text',text:'unexpected'}],usage}}, model => model)
  const stop=new AbortController();stop.abort()
  expect(await complete({model:'test',prompt:'hello'},stop.signal)).toEqual({isAnswered:false,reason:'aborted',usage:zero})
  expect(calls).toBe(0)
})
test('in-flight abort resolves even when a transport ignores its signal', async () => {
  const entered=Promise.withResolvers<void>()
  const complete = createModModelComplete(async () => {entered.resolve();return await new Promise(() => {})}, model => model)
  const stop=new AbortController()
  const pending=complete({model:'test',prompt:'hello'},stop.signal)
  await entered.promise;stop.abort(new Error('FAKE_PRIVATE_ABORT_REASON'))
  expect(await pending).toEqual({isAnswered:false,reason:'aborted',usage:zero})
})

test.each([
  [401,'authentication_failed'],[403,'authentication_failed'],[400,'unknown'],
  [404,'model_not_found'],[429,'rate_limit'],[500,'server_error'],[529,'server_error'],
] as const)('completion exposes only status and the named category for HTTP %s', async (status, category) => {
  const complete = createModModelComplete(async () => {
    throw APIError.generate(status,{error:{type:'api_error',message:'FAKE_PRIVATE_BODY'}},'FAKE_PRIVATE_DETAIL',new Headers({'x-private':'FAKE_PRIVATE_HEADER'}))
  }, model => model)
  expect(await complete({model:'test',prompt:'hello'})).toEqual({isAnswered:false,reason:'api-error',status,error:category,usage:zero})
})

test('classifier rejects each structured failure and reserves undefined for answered nonlabels', async () => {
  for (const failure of [
    {isAnswered:false,reason:'api-error',status:429,error:'rate_limit',usage:zero},
    {isAnswered:false,reason:'empty-reply',usage},
    {isAnswered:false,reason:'aborted',usage:zero},
  ] as const) {
    const classify = createModModelClassify(async () => failure, () => 'test')
    await expect(classify('hello',['one','two'])).rejects.toThrow(failure.reason === 'api-error' ? 'the request failed (HTTP 429, rate_limit)' : failure.reason === 'aborted' ? 'the request was aborted' : 'the model answered with no text')
  }
  const classify = createModModelClassify(async () => ({isAnswered:true,text:'other',usage}), () => 'test')
  expect(await classify('hello',['one','two'])).toBeUndefined()
})
