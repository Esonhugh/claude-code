import { expect, test } from 'bun:test'
import type { ModDeclaration } from './types.js'

test('an unreturned Client promise rejection is reported while the same surface and its hook Worker keep running', async () => {
  const declaration: ModDeclaration={
    name:'owner',storageId:'owner@test',pluginRoot:'/fixture',tier:'user',options:{},fingerprint:'detached-rejection',
    entrypoints:['/fixture/main.js'],events:['tool.call'],calls:[],nextTiers:[],links:[],
    clients:[{path:'/fixture/detached.js',module:'detached.js'}],
    modules:[{path:'/fixture/main.js',source:`export function register(on) {on('tool.call',()=> 'alive')}`},
      {path:'/fixture/detached.js',source:`export default function Detached(_,s) {
        if(s.state===undefined) {s.setState(0);s.every(1,()=>{
          s.setState(s.state+1);if(s.state===1) void Promise.reject(Error('unreturned failed'));
        })}return s.elements.Text({children:String(s.state)});
      }`}],
  }
  // Normal Bun owns detached rejections; the test runner intercepts them first.
  const source=`import {createModEnvironmentHost} from ${JSON.stringify(new URL('./environment.ts',import.meta.url).pathname)};
    const reported=Promise.withResolvers(),errors=[];
    const host=createModEnvironmentHost({onError:error=>{errors.push(error.message);reported.resolve()}});
    try {
      const environment=await host.load(${JSON.stringify(declaration)});
      await environment.client({op:'mount',id:1,module:'detached.js',now:0});
      await environment.client({op:'frame',id:1,now:1});
      await reported.promise;
      const frame=await environment.client({op:'frame',id:1,now:2});
      const result=await environment.invoke(environment.registrations[0].id,[]);
      console.log(JSON.stringify({frame,result,errors}));
    } finally {await host.dispose()}`
  const child=Bun.spawn([process.execPath,'-e',source],{stdout:'pipe',stderr:'pipe'})
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect(exit).toBe(0)
  expect(stderr).toBe('')
  const result=JSON.parse(stdout)
  expect(result.errors).toHaveLength(1)
  expect(result.errors[0]).toContain('unreturned failed')
  expect(result.frame.tree).toMatchObject({type:'Text',children:['2']})
  expect(result.result).toBe('alive')
})
