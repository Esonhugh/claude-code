import { expect, test } from 'bun:test'
import { isProxy } from 'node:util/types'
import { createModUiRealm } from './uiRealm.js'
import { createModClientRealm, copyModClientData } from './clientRealm.js'

function fixture() {
  const realm = createModClientRealm(createModUiRealm('fixture', isProxy))
  return realm
}

test('Client module props are immutable snapshots and unsupported async modules are rejected', () => {
  const realm=fixture()
  realm.register('props.ts',(props:any,s)=> {
    expect(Object.isFrozen(props)).toBe(true)
    expect(Object.isFrozen(props.nested)).toBe(true)
    return s.elements.Text({children:props.nested.value})
  })
  realm.request({op:'mount',id:1,module:'props.ts',props:{nested:{value:'ok'}}})
  realm.register('async.ts',async()=>({type:'Text',children:['late']}))
  expect(()=>realm.request({op:'mount',id:2,module:'async.ts'})).toThrow(/plain JSON|synchronous/)
})

test('Client JSON rejects sparse arrays and snapshots data without invoking accessors', () => {
  expect(() => copyModClientData(new Array(4))).toThrow(/dense/)
  let called = false
  expect(() => copyModClientData({get value(){called=true;return 1}})).toThrow(/accessors/)
  expect(called).toBe(false)
  expect(() => copyModClientData(new Proxy({},{}),isProxy)).toThrow(/JSON/)
  let deep:unknown = null
  for(let i=0;i<33;i++)deep=[deep]
  expect(()=>copyModClientData(deep)).toThrow(/depth/)
  expect(()=>copyModClientData(Array.from({length:20_001},()=>0))).toThrow(/value/)
})

test('Client callback failures and invalid trees unmount and revoke all instance resources', () => {
  const realm = fixture()
  let saved: any
  realm.register('bad.ts', (_, s) => {
    saved = s
    s.setState(1)
    s.every(10, () => {throw Error('tick failed')})
    return s.elements.Text({children:'ok'})
  })
  realm.request({op:'mount',id:1,module:'bad.ts',now:0})
  expect(() => realm.request({op:'frame',id:1,now:10})).toThrow('tick failed')
  expect(saved.state).toBeUndefined()
  expect(realm.request({op:'frame',id:1,now:20})).toEqual({stopped:true})
  realm.register('nested.ts', () => ({type:'Box',children:[{type:'Client',props:{key:'nested',module:'bad.ts'}}]}))
  expect(() => realm.request({op:'mount',id:2,module:'nested.ts'})).toThrow(/nested Client/)
  expect(realm.request({op:'frame',id:2,now:20})).toEqual({stopped:true})
})

test('Client posts last plain data per frame, revokes old callbacks and stops render loops', () => {
  const realm = fixture()
  let s: any, presses = 0
  realm.register('post.ts', (_, surface) => {
    s = surface
    return s.elements.Button({key:'send',label:'Send',onPress:() => {presses++;s.post({presses})}})
  })
  const first: any = realm.request({op:'mount',id:1,module:'post.ts'})
  s.post({value:1}); s.post({value:2})
  s.post({closure:() => {}})
  s.post('x'.repeat(100_001))
  expect(realm.request({op:'frame',id:1,now:16}).post).toEqual({value:2})
  expect(realm.request({op:'frame',id:1,now:32}).post).toBeUndefined()
  realm.request({op:'press',id:1,handle:first.tree.press.handle,event:{}})
  expect(realm.request({op:'frame',id:1,now:48}).post).toEqual({presses:1})
  realm.request({op:'update',id:1,props:{}})
  expect(() => realm.request({op:'press',id:1,handle:first.tree.press.handle,event:{}})).toThrow(/stale/)
  realm.request({op:'dispose',id:1})
  expect(realm.request({op:'press',id:1,handle:first.tree.press.handle,event:{}})).toEqual({stopped:true})
  expect(presses).toBe(1)
  realm.register('loop.ts', (_, surface) => {
    surface.setState((surface.state ?? 0) + 1)
    return surface.elements.Text({children:'loop'})
  })
  realm.request({op:'mount',id:2,module:'loop.ts'})
  realm.request({op:'frame',id:2,now:16})
  expect(() => realm.request({op:'frame',id:2,now:32})).toThrow(/render loop/)
  expect(realm.request({op:'frame',id:2,now:48})).toEqual({stopped:true})
})

test('Client every and replacing input listeners belong only to their mounted instance', () => {
  const realm = fixture()
  const saved: any[] = []
  let ticks = 0, oldPointer = 0, pointers = 0, keys = 0
  realm.register('clock.ts', (_, s) => {
    if (s.state === undefined) {
      s.setState(0)
      const stop = s.every(20, () => { ticks++; s.setState(s.state + 1) })
      const clearOld = s.onPointer(() => oldPointer++)
      s.onPointer(() => { pointers++; s.setState(10) })
      clearOld()
      s.onKey(() => keys++)
      saved.push({s, stop})
    }
    return s.elements.Text({children:s.state})
  })
  realm.request({op:'mount',id:1,module:'clock.ts',now:0})
  realm.request({op:'mount',id:2,module:'clock.ts',now:0})
  expect(realm.request({op:'frame',id:1,now:20}).tree).toMatchObject({children:['1']})
  expect(ticks).toBe(1)
  realm.request({op:'pointer',id:1,event:{type:'down',x:1,y:1}})
  realm.request({op:'key',id:1,event:{key:'a'}})
  realm.request({op:'key',id:1,event:{key:'escape'}})
  expect([oldPointer,pointers,keys]).toEqual([0,1,1])
  realm.request({op:'dispose',id:1})
  realm.request({op:'frame',id:1,now:40})
  realm.request({op:'pointer',id:1,event:{type:'down',x:1,y:1}})
  realm.request({op:'key',id:1,event:{key:'a'}})
  expect(saved[0].s.state).toBeUndefined()
  expect([ticks,pointers,keys]).toEqual([1,1,1])
  saved[1].stop()
  realm.request({op:'frame',id:2,now:40})
  expect(ticks).toBe(1)
})

test('Client keeps per-instance state and stable surface; setState coalesces until the next frame', () => {
  const realm = fixture()
  const surfaces: any[] = []
  let draws = 0
  realm.register('counter.ts', (props: any, surface: any) => {
    draws++
    surfaces.push(surface)
    if (surface.state === undefined) surface.setState(0)
    return surface.elements.Text({children:`${props.label}:${surface.state}`})
  })
  realm.request({op:'mount',id:1,module:'counter.ts',props:{label:'a'},now:0})
  realm.request({op:'mount',id:2,module:'counter.ts',props:{label:'b'},now:0})
  realm.request({op:'frame',id:1,now:16}); realm.request({op:'frame',id:2,now:16})
  const count = draws
  surfaces[0].setState(1); surfaces[0].setState(2); surfaces[0].setState(3)
  expect(draws).toBe(count)
  expect(realm.request({op:'frame',id:1,now:32}).tree).toMatchObject({children:['a:3']})
  expect(draws).toBe(count + 1)
  expect(realm.request({op:'frame',id:2,now:32}).tree).toBeUndefined()
  expect(realm.request({op:'update',id:1,props:{label:'new'}}).tree).toMatchObject({children:['new:3']})
  expect(surfaces[0]).toBe(surfaces.at(-1))
  realm.request({op:'dispose',id:1})
  surfaces[0].setState(99)
  expect(realm.request({op:'frame',id:1,now:48})).toEqual({stopped:true})
  expect(realm.request({op:'mount',id:1,module:'counter.ts',props:{label:'again'},now:48}).tree).toMatchObject({children:['again:0']})
})
