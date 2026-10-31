import { feature } from 'bun:bundle'
import { shouldAutoEnableClaudeInChrome } from 'src/utils/claudeInChrome/setup.js'
import { registerBatchSkill } from './batch.js'
import { registerClaudeApiSkill } from './claudeApi.js'
import { registerClaudeInChromeSkill } from './claudeInChrome.js'
import { registerCodeReviewSkill } from './codeReview.js'
import { registerDatavizSkill } from './dataviz.js'
import { registerDebugSkill } from './debug.js'
import { registerDoctorSkill } from './doctor.js'
import { registerFewerPermissionPromptsSkill } from './fewerPermissionPrompts.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerTerminalSkill } from './terminal.js'
import { registerLoremIpsumSkill } from './loremIpsum.js'
import { registerPluginAuthoringSkill } from './pluginAuthoring.js'
import { registerRememberSkill } from './remember.js'
import { registerRunSkill, registerRunSkillGeneratorSkill } from './run.js'
import { registerSimplifySkill } from './simplify.js'
import { registerSkillifySkill } from './skillify.js'
import { registerStuckSkill } from './stuck.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerVerifySkill } from './verify.js'
import { registerWorkflowAuthoringSkill } from './workflowAuthoring.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  // Official 2.1.311 order: menus and init list skills in registration order.
  registerDatavizSkill()
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerVerifySkill()
  registerDebugSkill()
  registerCodeReviewSkill()
  registerSimplifySkill()
  registerBatchSkill()
  registerFewerPermissionPromptsSkill()
  registerDoctorSkill()
  if (feature('AGENT_TRIGGERS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerLoopSkill } = require('./loop.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    // /loop's isEnabled delegates to isKairosCronEnabled() — same lazy
    // per-invocation pattern as the cron tools. Registered unconditionally;
    // the skill's own isEnabled callback decides visibility.
    registerLoopSkill()
  }
  registerClaudeApiSkill()
  registerWorkflowAuthoringSkill()
  registerRunSkill()
  registerRunSkillGeneratorSkill()
  registerPluginAuthoringSkill()
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerStuckSkill()
  registerTerminalSkill()
  if (feature('KAIROS') || feature('KAIROS_DREAM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerDreamSkill } = require('./dream.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerDreamSkill()
  }
  if (feature('REVIEW_ARTIFACT')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerHunterSkill } = require('./hunter.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerHunterSkill()
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerAutoModeSetupSkill } = require('./autoModeSetup.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerAutoModeSetupSkill()
  }
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('./scheduleRemoteAgents.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerScheduleRemoteAgentsSkill()
  }
  if (shouldAutoEnableClaudeInChrome()) {
    registerClaudeInChromeSkill()
  }
}
