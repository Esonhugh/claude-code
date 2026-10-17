import {afterEach,expect,spyOn,test} from 'bun:test'
import {resetStateForTests} from '../../bootstrap/state.js'
import {getDefaultAppState} from '../../state/AppStateStore.js'
import {captureModSessionUsage,validateModSessionUsage} from './sessionUsage.js'
let restore:(()=>void)|undefined
afterEach(()=>{restore?.();restore=undefined;resetStateForTests()})
function reader(){const state=getDefaultAppState();return captureModSessionUsage({messages:[],getAppState:()=>state,options:{mainLoopModel:'claude-sonnet-4-6',tools:[],agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined}}})}
test('session usage carries the CLI start and preserves its captured snapshot across a fresh session state',async()=>{
 const start=1791080000123;let now=start
 const clock=spyOn(Date,'now').mockImplementation(()=>now);restore=()=>clock.mockRestore();resetStateForTests()
 const captured=reader();now+=100000
 expect((await captured({})).startedAt).toBe(start)
 expect((await reader()({})).startedAt).toBe(start)
 resetStateForTests()
 expect((await captured({})).startedAt).toBe(start)
 expect((await reader()({})).startedAt).toBe(now)
})
test('official session usage requires a finite integer start timestamp',()=>{
 const usage={context:{window:200000},rateLimits:[]}
 expect(()=>validateModSessionUsage({...usage,startedAt:1791080000123})).not.toThrow()
 expect(()=>validateModSessionUsage(usage)).toThrow('session.usage')
 for(const startedAt of [-1,1.5,Infinity,NaN,'123',Number.MAX_SAFE_INTEGER+1])expect(()=>validateModSessionUsage({...usage,startedAt})).toThrow('session.usage')
})
