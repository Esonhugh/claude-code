import { registerBundledSkill } from '../bundledSkills.js'
import { canSpawnAgents } from './codeReview.js'
import { SIMPLIFY_FAN_OUT, SIMPLIFY_INLINE } from './codeReviewContent.js'

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    menuDescription: 'Clean up the changed code without changing behavior',
    description:
      'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.',
    argumentHint: '[<target>]',
    userInvocable: true,
    async getPromptForCommand(args, context) {
      const target = args.trim()
      const targetText = target ? `Review target: \`${target}\`\n\n` : ''
      const prompt = canSpawnAgents(context) ? SIMPLIFY_FAN_OUT : SIMPLIFY_INLINE
      return [{ type: 'text', text: `${targetText}${prompt}` }]
    },
  })
}
