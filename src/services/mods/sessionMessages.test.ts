import { expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { projectModSessionMessages } from './sessionMessages.js'

test('projects joined text and structured tool outcomes without mutating the transcript', () => {
  const call = createAssistantMessage({content:[
    {type:'text', text:'before', citations:[]},
    {type:'tool_use', id:'ok', name:'Read', input:{file_path:'a'}},
    {type:'tool_use', id:'failed', name:'Write', input:{}},
    {type:'tool_use', id:'pending', name:'Bash', input:{command:'true'}},
    {type:'text', text:'after', citations:[]},
  ]})
  const result = {kind:'text', content:'structured'}
  const messages = [call,
    createUserMessage({content:[{type:'tool_result', tool_use_id:'ok', content:[{type:'text', text:'a'},{type:'text', text:'b'}]}], toolUseResult:result}),
    createUserMessage({content:[{type:'tool_result', tool_use_id:'failed', content:'denied', is_error:true}], toolUseResult:'denied'}),
  ]
  const before = structuredClone(messages)
  expect(projectModSessionMessages(messages)).toEqual([
    {role:'assistant', text:'beforeafter', toolUses:[
      {tool_use_id:'ok', tool:'Read', input:{file_path:'a'}, result, text:'ab'},
      {tool_use_id:'failed', tool:'Write', input:{}, result:'denied', text:'denied', isError:true},
      {tool_use_id:'pending', tool:'Bash', input:{command:'true'}},
    ]},
    {role:'user', text:'', toolUses:[], toolResults:[{tool_use_id:'ok', text:'ab', isError:false, result}]},
    {role:'user', text:'', toolUses:[], toolResults:[{tool_use_id:'failed', text:'denied', isError:true, result:'denied'}]},
  ])
  expect(messages).toEqual(before)
})

test('filters non-conversation and meta user messages and retains only the newest 4096', () => {
  const messages = Array.from({length:4100}, (_, i) => createUserMessage({content:String(i)}))
  messages.push(createUserMessage({content:'meta', isMeta:true}))
  messages.push({...createUserMessage({content:'virtual'}), isVirtual:true})
  const result = projectModSessionMessages([...messages, {type:'progress'} as any])
  expect(result).toHaveLength(4096)
  expect(result[0]).toEqual({role:'user', text:'4', toolUses:[]})
  expect(result.at(-1)?.text).toBe('4099')
})

test('a tool without a stored record keeps result absent rather than inventing one', () => {
  const messages = [
    createAssistantMessage({content:[{type:'tool_use', id:'x', name:'Bash', input:{}}]}),
    createUserMessage({content:[{type:'tool_result', tool_use_id:'x', content:'output'}]}),
  ]
  const result = projectModSessionMessages(messages)
  expect(result[0]?.toolUses[0]).toEqual({tool_use_id:'x', tool:'Bash', input:{}, text:'output'})
  expect(result[1]?.toolResults?.[0]).toEqual({tool_use_id:'x', text:'output', isError:false})
})
