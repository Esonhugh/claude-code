import { findToolByName, type Tool, type Tools } from '../Tool.js'
import { AgentTool } from '../tools/AgentTool/AgentTool.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { ClearGoalTool } from '../tools/ClearGoalTool/ClearGoalTool.js'
import { FileEditTool } from '../tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js'
import { MCPTool } from '../tools/MCPTool/MCPTool.js'
import { SendMessageTool } from '../tools/SendMessageTool/SendMessageTool.js'
import { SetGoalTool } from '../tools/SetGoalTool/SetGoalTool.js'
import { TaskCreateTool } from '../tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from '../tools/TaskGetTool/TaskGetTool.js'
import { TaskListTool } from '../tools/TaskListTool/TaskListTool.js'
import { TaskOutputTool } from '../tools/TaskOutputTool/TaskOutputTool.js'
import { TaskStopTool } from '../tools/TaskStopTool/TaskStopTool.js'
import { TaskUpdateTool } from '../tools/TaskUpdateTool/TaskUpdateTool.js'
import { TeamCreateTool } from '../tools/TeamCreateTool/TeamCreateTool.js'
import { TeamDeleteTool } from '../tools/TeamDeleteTool/TeamDeleteTool.js'
import { TerminalTool } from '../tools/TerminalTool/TerminalTool.js'
import { WorkflowTool } from '../tools/WorkflowTool/WorkflowTool.js'

const remoteDisplayToolCache = new Map<string, Tool>()

function getKnownRemoteDisplayTools(): Tools {
  return [
    AgentTool,
    BashTool,
    ClearGoalTool,
    FileEditTool,
    FileReadTool,
    FileWriteTool,
    SendMessageTool,
    SetGoalTool,
    TaskCreateTool,
    TaskGetTool,
    TaskListTool,
    TaskOutputTool,
    TaskStopTool,
    TaskUpdateTool,
    TeamCreateTool,
    TeamDeleteTool,
    TerminalTool,
    WorkflowTool,
  ]
}

function makeNonExecutable(tool: Tool): Tool {
  return {
    ...tool,
    isEnabled: () => false,
    async call() {
      throw new Error(
        `Display-only remote tool ${tool.name} cannot be executed locally`,
      )
    },
  } as Tool
}

export function createRemoteDisplayTool(toolName: string): Tool {
  return {
    ...MCPTool,
    name: toolName,
    userFacingName: () => toolName,
    isEnabled: () => false,
    async call() {
      throw new Error(
        `Display-only remote tool ${toolName} cannot be executed locally`,
      )
    },
  } as Tool
}

export function findRemoteDisplayTool(
  tools: Tools,
  toolName: string,
): Tool {
  const localTool = findToolByName(tools, toolName)
  if (localTool) return localTool

  const cached = remoteDisplayToolCache.get(toolName)
  if (cached) return cached

  const knownTool = findToolByName(getKnownRemoteDisplayTools(), toolName)
  if (knownTool) {
    const tool = makeNonExecutable(knownTool)
    remoteDisplayToolCache.set(toolName, tool)
    return tool
  }

  const tool = createRemoteDisplayTool(toolName)
  remoteDisplayToolCache.set(toolName, tool)
  return tool
}
