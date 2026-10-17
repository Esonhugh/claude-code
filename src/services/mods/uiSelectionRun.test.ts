import { expect, test } from 'bun:test'
import { handlePromptSubmit, type HandlePromptSubmitParams } from '../../utils/handlePromptSubmit.js'
import { QueryGuard } from '../../utils/QueryGuard.js'
import { createUserMessage } from '../../utils/messages.js'

test.each([false,true])('actual admitted input execution starts and finishes its UI run after query settlement (reject=%s)',async reject=>{
  const events:string[]=[]
  const guard=new QueryGuard()
  const params={
    queuedCommands:[{value:'accepted',mode:'prompt',admitted:{messages:[createUserMessage({content:'accepted'})],shouldQuery:false}}],
    messages:[],mainLoopModel:'fixture',ideSelection:undefined,querySource:'repl_main_thread',commands:[],queryGuard:guard,
    helpers:{setCursorOffset(){},clearBuffer(){},resetHistory(){}},onInputChange(){},setPastedContents(){},setToolJSX(){},getToolUseContext(){throw Error('admitted inputs do not preprocess')},setUserInputOnProcessing(){},setAbortController(){},setAppState(){},
    onInputRun:()=>{events.push('begin');return()=>events.push('end')},
    onQuery:async()=>{events.push('query');await Promise.resolve();events.push('settled');if(reject)throw Error('query rejected')},
  } as HandlePromptSubmitParams
  if(reject)await expect(handlePromptSubmit(params)).rejects.toThrow('query rejected')
  else await handlePromptSubmit(params)
  expect(events).toEqual(['begin','query','settled','end'])
  expect(guard.isActive).toBe(false)
})
