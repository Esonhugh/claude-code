import { expect, test } from 'bun:test'
import { appendChildNode, createNode } from './dom.js'
import { ClickEvent } from './events/click-event.js'
import { dispatchMouseClick } from './hit-test.js'
import { nodeCache } from './node-cache.js'

test('actual hit test focuses a settled click, skips activation focus, and preserves stray through parent bubble', () => {
  const root=createNode('ink-root'), button=createNode('ink-box'), text=createNode('ink-text')
  appendChildNode(root,button);appendChildNode(button,text)
  for(const node of [root,button,text])nodeCache.set(node,{x:0,y:0,width:12,height:1})
  button.attributes.tabIndex=0
  const focus: unknown[]=[], calls: string[]=[]
  root.focusManager={handleClickFocus(node){focus.push(node)}} as never
  button._eventHandlers={onClick(event:ClickEvent){calls.push('button');event.dropAsStray()}}
  root._eventHandlers={onClick(event:ClickEvent){calls.push('parent');event.stopImmediatePropagation()}}
  expect(dispatchMouseClick(root,new ClickEvent(7,0,false))).toBe('stray')
  expect(focus).toEqual([button])
  expect(calls).toEqual(['button','parent'])
  focus.length=0;calls.length=0
  expect(dispatchMouseClick(root,new ClickEvent(7,0,false,undefined,true))).toBe('stray')
  expect(focus).toEqual([])
  expect(calls).toEqual(['button','parent'])
})

test('allowDefault and endClickChain use the handled bubble result', () => {
  const root=createNode('ink-root'),button=createNode('ink-box')
  appendChildNode(root,button)
  for(const node of [root,button])nodeCache.set(node,{x:0,y:0,width:12,height:1})
  button._eventHandlers={onClick(event:ClickEvent){event.endClickChain()}}
  expect(dispatchMouseClick(root,new ClickEvent(1,0,false))).toBe('repeat')
  root._eventHandlers={onClick(event:ClickEvent){event.allowDefault();event.stopImmediatePropagation()}}
  expect(dispatchMouseClick(root,new ClickEvent(1,0,false))).toBe('unhandled')
})
