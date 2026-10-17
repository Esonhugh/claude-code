import {afterEach,expect,test} from 'bun:test'
import {createModEnvironmentHost, type ModEnvironment} from './environment.js'
import {createModHookStream} from './protocol.js'
import type {ModDeclaration} from './types.js'

const hosts:ReturnType<typeof createModEnvironmentHost>[]=[]
afterEach(async()=>{await Promise.all(hosts.splice(0).map(host=>host.dispose()))})
const numbers=[NaN,Infinity,-Infinity]
async function load(source:string,event='tool.call'){
  const host=createModEnvironmentHost();hosts.push(host)
  const declaration:ModDeclaration={name:'number-fixture',storageId:'number-fixture@local',pluginRoot:'/number-fixture',
    entrypoints:['/number-fixture/register.js'],modules:[{path:'/number-fixture/register.js',source}],
    links:[],events:[event],calls:[],nextTiers:[],options:{},tier:'user',fingerprint:source}
  return host.load(declaration)
}
function next<Result>(call:(input:Record<string,unknown>)=>Result){
  return Object.assign(call,{to:call,is:(event:string)=>event==='tool.call',signal:new AbortController().signal,event:'tool.call',
    origin:{plugin:'engine',tier:'core' as const},trace:[],budget:{ms:1000,remainingMs:1000}})
}

test('generic Worker preserves nonfinite host inputs, guest rewrites, next replies and terminal results',async()=>{
  const environment=await load(`export function register(on){on('tool.call',async(_,e,next)=>{
    const below=await next({...e,values:[NaN,Infinity,-Infinity]});
    return {input:e.values,below:below.values,local:[NaN,Infinity,-Infinity]};
  })}`)
  let forwarded:unknown
  const result=await environment.invoke(environment.registrations[0]!.id,[{},{values:numbers}],next(async input=>{
    forwarded=input.values;return {values:numbers};
  }))
  expect(forwarded).toEqual(numbers)
  expect(result).toEqual({input:numbers,below:numbers,local:numbers})
})

test('generic host-function calls preserve nonfinite arguments and returned fields',async()=>{
  const environment=await load(`export function register(on){on('tool.call',async($)=>{
    const reply=await $.probe.read({values:[NaN,Infinity,-Infinity]});return {values:reply.values};
  })}`)
  let forwarded:unknown
  const result=await environment.invoke(environment.registrations[0]!.id,[{probe:{read:(input:{values:unknown})=>{
    forwarded=input.values;return {values:numbers};
  }}}])
  expect(forwarded).toEqual(numbers);expect(result).toEqual({values:numbers})
})

test('generic Worker streams preserve nonfinite chunks and completion through both realms',async()=>{
  const environment=await load(`export function register(on){on('turn.step',async function*(_,e,next){return yield* next(e)})}`,'turn.step')
  const frame=next(()=>createModHookStream(async()=>({done:true,value:undefined})))
  frame.event='turn.step'
  const source=async function*(){yield {values:numbers};return {values:numbers}}
  const continuation=Object.assign((_input:Record<string,unknown>)=>createModHookStream((()=>{const stream=source();return (method:'next'|'return'|'throw',value:unknown)=>stream[method](value as never)})()),frame)
  // HEAD models stream continuations as promise-based ModNext; ROOT has ModStreamNext.
  const stream=environment.invokeStream(environment.registrations[0]!.id,[{},{}],continuation as unknown as Parameters<ModEnvironment['invokeStream']>[2])
  expect(await stream.next()).toEqual({done:false,value:{values:numbers}})
  expect(await stream.next()).toEqual({done:true,value:{values:numbers}})
  expect(await stream.result).toEqual({values:numbers})
})
