import { getCoordinatorSystemPrompt } from '../coordinator/coordinatorMode.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import type { Project } from './projectsDb.js'

/** The tools a `claude -p` coordinator keeps (src/utils/toolPool.ts filters to these). */
const COORDINATOR_TOOLS = [AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, TASK_STOP_TOOL_NAME, SKILL_TOOL_NAME]

export type CoordinatorSpawn = {
  systemPrompt: string
  appendSystemPrompt?: string
  env: Record<string, string>
}

/**
 * What a project's coordinator child gets beyond a normal session
 * (docs/design/claude-web-project.md 4.1). `-p` keeps the default system
 * prompt even in coordinator mode (only the REPL swaps it, in
 * src/utils/systemPrompt.ts), so the prompt is built here, in the same
 * binary, and passed as `--system-prompt`.
 */
export function coordinatorSpawn(project: Pick<Project, 'instructions' | 'worker_model'>): CoordinatorSpawn {
  const instructions = project.instructions.trim()
  return {
    systemPrompt: getCoordinatorSystemPrompt(COORDINATOR_TOOLS),
    ...(instructions && { appendSystemPrompt: instructions }),
    env: {
      CLAUDE_CODE_COORDINATOR_MODE: '1',
      // Turn boundaries, so a settings change can restart an idle coordinator.
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      ...(project.worker_model && { CLAUDE_CODE_SUBAGENT_MODEL: project.worker_model }),
    },
  }
}
