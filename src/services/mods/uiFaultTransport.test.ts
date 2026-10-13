import { expect, test } from 'bun:test'
import { createModEnvironmentHost } from './environment.js'
import type { ModDeclaration } from './types.js'

test('real Client timer error reaches the host as a run failure and leaves its hook Worker alive', async () => {
  const host = createModEnvironmentHost()
  const declaration: ModDeclaration = {
    name:'owner',storageId:'owner@test',pluginRoot:'/fixture',tier:'user',options:{},fingerprint:'timer-failure',
    entrypoints:['/fixture/main.js'],events:['tool.call'],calls:[],nextTiers:[],links:[],
    clients:[{path:'/fixture/timer.js',module:'timer.js'}],
    modules:[{path:'/fixture/main.js',source:`export function register(on) {on('tool.call',()=> 'alive')}`},
      {path:'/fixture/timer.js',source:`export default function Timer(_,s) {if(s.state===undefined) {s.setState(0);s.every(1,()=>{throw Error('timer failed')})}return s.elements.Text({children:'ready'})}`}],
  }
  try {
    const environment = await host.load(declaration)
    await environment.client({op:'mount',id:1,module:'timer.js',now:0})
    const error = await environment.client({op:'frame',id:1,now:1}).then(()=>null,error=>error)
    expect(error).toMatchObject({message:'timer failed',phase:'run',name:'Error'})
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
  } finally {await host.dispose()}
})
