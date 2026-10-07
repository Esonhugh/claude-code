import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldHideAssistantSummaryHint } from './assistantSummaryDisplay.js'
import { getFirstPartyModelCacheKey } from './firstPartyModelCacheKey.js'
import { saveGlobalConfig } from '../config.js'
import { resetSettingsCache } from '../settings/settingsCache.js'

const keys=['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_MODEL_CAPABILITIES','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION','ANTHROPIC_BASE_URL']
let previous:(string|undefined)[],root:string
beforeEach(async()=>{
 previous=keys.map(key=>process.env[key]);root=await realpath(await mkdtemp(join(tmpdir(),'summary-model-test-')))
 for(const key of keys.slice(0,4))process.env[key]=root
 for(const key of keys.slice(4))delete process.env[key]
 process.env.ANTHROPIC_API_KEY='owned-placeholder';resetSettingsCache()
})
afterEach(async()=>{
 await rm(root,{recursive:true,force:true});keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i]});resetSettingsCache()
})

test.each([
 ['claude-sonnet-4-6',undefined,false],['claude-opus-5-5',undefined,true],['claude-opus-5',undefined,false],['claude-fable-5-1',undefined,false],
 ['claude-opus-5-5[1m]',undefined,true],['us.anthropic.claude-opus-5-5-v1:0',undefined,true],
 ['custom-model','quizzical_shore',true],['claude-opus-5-5','-quizzical_shore',false],
 ['claude-sonnet-4-6','quizzical_shore,-quizzical_shore',false],
 ['claude-sonnet-4-6','-quizzical_shore;claude-sonnet*=quizzical_shore',true],
 ['claude-sonnet-4-6','claude-opus*=quizzical_shore',false],
 ['claude-sonnet-4-6','=quizzical_shore',false],
 ['claude-sonnet-4-6',' opus_5_5_prompt_bundle ',true],
 ['claude-opus-5-5','-opus_5_5_prompt_bundle',false],
])('hint capability %s with %s', (model,overrides,expected)=>{
 if(overrides!==undefined)process.env.CLAUDE_CODE_MODEL_CAPABILITIES=overrides
 expect(shouldHideAssistantSummaryHint(model)).toBe(expected)
})

test.each(['local-agent','local_agent','remote_cowork','remote_cowork_trigger'])('host surface %s disables inherited bundle default, but an explicit hint capability wins',entrypoint=>{
 process.env.CLAUDE_CODE_ENTRYPOINT=entrypoint
 expect(shouldHideAssistantSummaryHint('claude-opus-5-5')).toBe(false)
 process.env.CLAUDE_CODE_MODEL_CAPABILITIES='quizzical_shore'
 expect(shouldHideAssistantSummaryHint('claude-opus-5-5')).toBe(true)
 delete process.env.CLAUDE_CODE_MODEL_CAPABILITIES
 process.env.CLAUDE_CODE_CHILD_SESSION='1'
 expect(shouldHideAssistantSummaryHint('claude-opus-5-5')).toBe(true)
})

test('only matching provider/account bootstrap flags can override the model default; booleans stay strict',()=>{
 const cacheKey=getFirstPartyModelCacheKey();expect(cacheKey).not.toBeNull()
 for(const value of [true,false,'true',null]) {
  saveGlobalConfig(c=>({...c,bootstrapCacheKey:cacheKey!,clientDataCache:{quizzical_shore:value}}))
  expect(shouldHideAssistantSummaryHint('claude-sonnet-4-6')).toBe(value===true)
  expect(shouldHideAssistantSummaryHint('claude-opus-5-5')).toBe(value!==false)
 }
 saveGlobalConfig(c=>({...c,bootstrapCacheKey:'wrong-account',clientDataCache:{quizzical_shore:true}}))
 expect(shouldHideAssistantSummaryHint('claude-sonnet-4-6')).toBe(false)
 saveGlobalConfig(c=>({...c,bootstrapCacheKey:cacheKey!,clientDataCache:{quizzical_shore:true}}))
 process.env.CLAUDE_CODE_MODEL_CAPABILITIES='-quizzical_shore'
 expect(shouldHideAssistantSummaryHint('claude-sonnet-4-6')).toBe(false)
})
