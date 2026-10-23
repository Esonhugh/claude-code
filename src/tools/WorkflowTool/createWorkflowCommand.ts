import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Command } from '../../commands.js'
import { WORKFLOW_AUTHORING_SKILL_NAME } from '../../skills/bundled/workflowAuthoring.js'
import type { WorkflowArgs } from './workflowSpec.js'
import type { DiscoveredWorkflowSpec } from './workflowDiscovery.js'
import { discoverWorkflowSpecs, loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'

function formatWorkflowArgs(args: WorkflowArgs | undefined): string {
  if (args === undefined) return ''
  if (typeof args === 'string') return args
  return JSON.stringify(args, null, 2)
}

// The official 2.1.303 saved-workflow slash command prompt: name, description, the meta phases,
// the Workflow({ name, args }) call to make, and the pointer to the authoring skill.
function buildWorkflowPrompt(
  workflow: DiscoveredWorkflowSpec,
  args: WorkflowArgs | undefined,
): ContentBlockParam[] {
  const formattedArgs = formatWorkflowArgs(args).trim()
  if (workflow.plan.requiresInput && !formattedArgs) {
    return [{ type: 'text', text: `Usage: /${workflow.commandName} <workflow input>` }]
  }
  const phases =
    workflow.spec.meta?.phases ??
    workflow.plan.phases.map(phase => ({ title: phase.id, detail: phase.description }))
  const phaseLines = phases.map(phase => `- ${phase.title}${phase.detail ? `: ${phase.detail}` : ''}`)
  const invokeArgs = formattedArgs ? `, args: ${JSON.stringify(formattedArgs)}` : ''
  return [
    {
      type: 'text',
      text:
        `Run the "${workflow.commandName}" workflow.\n\n` +
        `${workflow.plan.description}\n\n` +
        (phaseLines.length > 0 ? `Phases:\n${phaseLines.join('\n')}\n\n` : '') +
        `Invoke: Workflow({ name: "${workflow.commandName}"${invokeArgs} })\n\n` +
        `If the user asks you to modify this workflow or write a new script, load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill first.`,
    },
  ]
}

const BUNDLED_SLASH_WORKFLOW_COMMANDS = new Set(['code-review', 'deep-research'])

function shouldRegisterWorkflowSlashCommand(workflow: DiscoveredWorkflowSpec): boolean {
  if (!workflow.path.startsWith('bundled:')) return true
  return BUNDLED_SLASH_WORKFLOW_COMMANDS.has(workflow.commandName)
}

export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  const discovery = await discoverWorkflowSpecs(cwd)
  return discovery.valid.filter(shouldRegisterWorkflowSlashCommand).map(workflow => {
    const commandName = workflow.commandName
    const prompt = buildWorkflowPrompt(workflow, undefined)
    return {
      type: 'prompt',
      name: workflow.commandName,
      description: workflow.plan.description,
      // A saved workflow's required meta.description lists it for the Skill tool like official.
      hasUserSpecifiedDescription: !workflow.path.startsWith('bundled:'),
      argumentHint: '[workflow input/context]',
      progressMessage: 'orchestrating workflow',
      contentLength: prompt.reduce((length, block) => length + (block.type === 'text' ? block.text.length : 0), 0),
      source: 'projectSettings',
      kind: 'workflow',
      async getPromptForCommand(args): Promise<ContentBlockParam[]> {
        return buildWorkflowPrompt(await loadWorkflowSpecByNameOrPath(cwd, commandName, args), args)
      },
    } satisfies Command
  })
}
