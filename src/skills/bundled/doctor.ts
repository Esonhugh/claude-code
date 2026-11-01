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
      "Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local data (duplicate or leftover installs, PATH, unparseable settings files, broken or colliding agent definitions, skills whose frontmatter fails to parse); find unused skills, MCP servers, and plugins versus their context cost and disable dead weight; deduplicate local CLAUDE.md files against checked-in ones; trim checked-in CLAUDE.md files by cutting content a session could derive from the codebase (directory layouts, tech-stack lists, architecture overviews) while keeping gotchas, rationale, and non-standard conventions; migrate always-loaded CLAUDE.md guidance into lazy skills and nested CLAUDE.md files; flag slow hooks and context-heavy extensions; check the installed version is current; make auto mode the default permission mode; and pre-approve frequently denied read-only commands. Use when the user asks for a doctor run, checkup, audit, tune-up, or cleanup of their Claude Code setup or configuration.",
    menuDescription:
      'Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory files, slow hooks, updates, permissions',
    argumentHint: '[prompt-audit [<path>]]',
    progressMessage: 'running checkup',
    terminalOriented: true,
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
