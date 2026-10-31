import { isCommandEnabled } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getBundledSkills, registerBundledSkill } from '../bundledSkills.js'
import {
  DOCTOR_PROMPT_AUDIT_ARGS,
  DOCTOR_PROMPT_AUDIT_UNAVAILABLE,
  doctorPrompt,
} from './doctorContent.js'

export function registerDoctorSkill(): void {
  registerBundledSkill({
    name: 'doctor',
    aliases: ['checkup'],
    description:
      'Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory files, slow hooks, updates, permissions',
    argumentHint: '[prompt-audit [<path>]]',
    progressMessage: 'running checkup',
    userInvocable: true,
    disableModelInvocation: true,
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
    async getPromptForCommand(args, context) {
      const trimmed = args.trim()
      if (trimmed.split(/\s+/)[0]?.toLowerCase() === 'prompt-audit') {
        const claudeApi = getBundledSkills().find(skill => skill.name === 'claude-api')
        if (claudeApi?.type !== 'prompt' || !isCommandEnabled(claudeApi)) {
          return [{ type: 'text', text: DOCTOR_PROMPT_AUDIT_UNAVAILABLE }]
        }
        return claudeApi.getPromptForCommand(
          /\s/.test(trimmed) ? trimmed : DOCTOR_PROMPT_AUDIT_ARGS,
          context,
        )
      }
      let prompt = doctorPrompt()
      if (args) {
        prompt += `\n\n## Additional instructions from the user\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
