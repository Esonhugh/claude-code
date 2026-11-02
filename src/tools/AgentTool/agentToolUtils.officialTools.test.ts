import assert from 'node:assert/strict'

import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import type { Tools } from '../../Tool.js'
import { MonitorTool } from '../MonitorTool/MonitorTool.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../ScheduleWakeupTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { filterToolsForAgent } from './agentToolUtils.js'

// Official 2.1.311 gives every subagent kind Monitor, SendMessage and TaskStop.
const names = [MonitorTool.name, SEND_MESSAGE_TOOL_NAME, TASK_STOP_TOOL_NAME]
for (const name of names) {
  assert.equal(ASYNC_AGENT_ALLOWED_TOOLS.has(name), true, name)
  assert.equal(ALL_AGENT_DISALLOWED_TOOLS.has(name), false, name)
}
const tools = names.map(name => ({ name })) as unknown as Tools
for (const isAsync of [false, true]) {
  for (const isBuiltIn of [false, true]) {
    assert.deepEqual(
      filterToolsForAgent({ tools, isBuiltIn, isAsync }).map(t => t.name),
      names,
    )
  }
}

// Official 2.1.311 keeps ScheduleWakeup (the /loop pacer) on the main thread only.
assert.equal(ALL_AGENT_DISALLOWED_TOOLS.has(SCHEDULE_WAKEUP_TOOL_NAME), true)

console.log('agentToolUtils.officialTools.test.ts passed')
