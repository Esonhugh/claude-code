import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Command } from '../../commands.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { formatWorkflowDryRun } from './formatWorkflowDryRun.js'
import type { DiscoveredWorkflowSpec } from './workflowDiscovery.js'
import { discoverWorkflowSpecs, loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'

function buildWorkflowPrompt(
  workflow: DiscoveredWorkflowSpec,
  args: string,
): ContentBlockParam[] {
  const dryRun = formatWorkflowDryRun(workflow.plan)
  const phaseDetails = workflow.plan.phases
    .map(
      phase =>
        `## Phase: ${phase.id}\n` +
        `Description: ${phase.description}\n` +
        `Depends on: ${phase.dependsOn.length ? phase.dependsOn.join(', ') : 'none'}\n` +
        `Fanout: ${phase.fanout}\n` +
        `Concurrency: ${phase.concurrency}\n` +
        `Review: ${phase.review}\n` +
        `permissionMode: ${phase.permissionMode}\n` +
        `agentType: ${phase.agentType ?? 'default'}\n` +
        `model: ${phase.model ?? 'default'}\n` +
        `Prompt: ${phase.prompt}`,
    )
    .join('\n\n')

  return [
    {
      type: 'text',
      text:
        `Workflow: ${workflow.commandName}\n` +
        `Source: ${workflow.path}\n\n` +
        `${dryRun}\n` +
        `User input:\n${args.trim() || '(none)'}\n\n` +
        `Execute this validated workflow as an orchestration plan. Use the ${AGENT_TOOL_NAME} tool for phase work. Do not bypass workflow phases by directly completing phase work with shell or filesystem tools in the main thread.\n\n` +
        `Rules:\n` +
        `- Respect phase dependencies: do not start a phase until all dependencies are complete.\n` +
        `- Respect each phase fanout and concurrency limit.\n` +
        `- For fanout greater than 1, launch separate ${AGENT_TOOL_NAME} workers with independent prompts.\n` +
        `- Honor each phase permissionMode when spawning workers: use mode \"plan\" for planning-only phases, mode \"acceptEdits\" only when the phase explicitly requests it, and omit mode for \"default\".\n` +
        `- A phase with permissionMode \"plan\" must not edit files or run implementation commands; it may only research, inspect, and propose a plan.\n` +
        `- For cross-check or adversarial review phases, have workers verify prior phase outputs and identify unsupported claims.\n` +
        `- For synthesis phases, include only findings that survived review.\n` +
        `- Agents inherit their normal Claude Code tool permissions and hooks; do not narrow child agents to the parent orchestration tool scope.\n` +
        `- Prefer WorkflowTool.run for execution when available so phase state, retries, status, pause/resume, and task progress are recorded by the workflow runtime.\n\n` +
        phaseDetails,
    },
  ]
}

export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  const discovery = await discoverWorkflowSpecs(cwd)
  return discovery.valid.map(workflow => {
    const commandName = workflow.commandName
    const dryRun = formatWorkflowDryRun(workflow.plan)
    return {
      type: 'prompt',
      name: workflow.commandName,
      description: workflow.plan.description,
      argumentHint: '[workflow input/context]',
      progressMessage: 'orchestrating workflow',
      contentLength: dryRun.length,
      source: 'projectSettings',
      kind: 'workflow',
      async getPromptForCommand(args): Promise<ContentBlockParam[]> {
        return buildWorkflowPrompt(await loadWorkflowSpecByNameOrPath(cwd, commandName, args), args)
      },
    } satisfies Command
  })
}
