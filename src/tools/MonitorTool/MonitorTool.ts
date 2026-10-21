import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatDuration } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { exec } from '../../utils/Shell.js'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'
import { createMonitorEventStream } from './monitorEvents.js'
import {
  buildMonitorExpiryMessage,
  DEFAULT_MONITOR_TIMEOUT_MS,
  getMonitorPrompt,
  getMonitorTimeoutCapMs,
  MAX_MONITOR_TIMEOUT_MS,
  MONITOR_COMMAND_DESCRIPTION,
  MONITOR_DESCRIPTION_FIELD,
  MONITOR_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    description: z.string().describe(MONITOR_DESCRIPTION_FIELD),
    timeout_ms: z
      .number()
      .min(1000)
      .max(
        MAX_MONITOR_TIMEOUT_MS,
        `timeout_ms must be ≤ ${MAX_MONITOR_TIMEOUT_MS}`,
      )
      .optional()
      .default(DEFAULT_MONITOR_TIMEOUT_MS)
      .describe(
        `Kill the monitor after this deadline. Default ${DEFAULT_MONITOR_TIMEOUT_MS}ms. Deadlines above ${getMonitorTimeoutCapMs()}ms are capped to ${getMonitorTimeoutCapMs()}ms. You are notified at expiry and can re-arm.`,
      ),
    command: z.string().describe(MONITOR_COMMAND_DESCRIPTION),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string().describe('ID of the background monitor task.'),
    timeoutMs: z.number().describe('Timeout deadline in milliseconds.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint:
    'watch, monitor, or keep an eye on a process/log/command — stream each stdout line as a live notification',
  maxResultSizeChars: 10_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName: () => 'Monitor',
  isEnabled() {
    // Monitors run as background shell tasks.
    return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  getActivityDescription(input) {
    return input?.description ? `Monitoring: ${input.description}` : 'Monitoring'
  },
  async description() {
    return getMonitorPrompt()
  },
  async prompt() {
    return getMonitorPrompt()
  },
  async checkPermissions(input, context) {
    // Same rules as Bash: an allowed Bash(prefix:*) also allows the monitor.
    const result = await bashToolHasPermission(
      { command: input.command, description: input.description },
      context,
    )
    return 'updatedInput' in result && result.updatedInput
      ? { ...result, updatedInput: input }
      : result
  },
  async call({ command, description, timeout_ms }, context) {
    const { abortController, toolUseId, agentId } = context
    const setAppState = context.setAppStateForTasks ?? context.setAppState
    const timeoutMs = Math.min(
      timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS,
      getMonitorTimeoutCapMs(),
    )

    const taskRef: { id?: string } = {}
    let exited = false
    const events = createMonitorEventStream({
      taskRef,
      description,
      agentId,
      killTask: () => {
        if (exited || !taskRef.id) return false
        killTask(taskRef.id, setAppState)
        return true
      },
    })

    const shellCommand = await exec(command, abortController.signal, 'bash', {
      onStdout: events.onData,
      preventCwdChanges: true,
      shouldUseSandbox: shouldUseSandbox({ command }),
    })
    if (shellCommand.status === 'killed') {
      events.close()
      throw new Error(
        'This call was interrupted before the monitor started; nothing is running.',
      )
    }
    if (shellCommand.status === 'completed') {
      const result = await shellCommand.result
      if (result.preSpawnError) {
        events.close()
        throw new Error(`Monitor: ${result.preSpawnError}`)
      }
    }

    const handle = await spawnShellTask(
      {
        command,
        description,
        shellCommand,
        toolUseId,
        agentId,
        kind: 'monitor',
      },
      {
        abortController,
        getAppState: context.getAppState,
        setAppState,
      },
    )
    taskRef.id = handle.taskId

    const deadline = setTimeout(() => {
      if (events.isClosed()) return
      events.flush()
      if (events.isClosed()) return
      events.notice(buildMonitorExpiryMessage(timeoutMs, events.eventCount()))
      events.close()
      killTask(handle.taskId, setAppState)
    }, timeoutMs)

    // Registered after spawnShellTask's own handler, which awaits an output
    // flush first, so trailing events land before the "stream ended" notice.
    void shellCommand.result.then(() => {
      exited = true
      clearTimeout(deadline)
      events.flush(true)
      events.close()
    })

    return { data: { taskId: handle.taskId, timeoutMs } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const expiry = formatDuration(output.timeoutMs, { hideTrailingZeros: true })
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Monitor started (task ${output.taskId}, expires in ${expiry} unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
