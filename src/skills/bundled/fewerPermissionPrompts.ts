import { registerBundledSkill } from '../bundledSkills.js'
import promptMd from './fewer-permission-prompts/prompt.md' with { type: 'text' }

export function registerFewerPermissionPromptsSkill(): void {
  registerBundledSkill({
    name: 'fewer-permission-prompts',
    description:
      'Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let text = promptMd
      if (args) text += `\n\n## Additional instructions from the user\n\n${args}`
      return [{ type: 'text', text }]
    },
  })
}
