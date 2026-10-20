/**
 * Auto mode subcommand handlers — dump default/merged classifier rules and
 * critique user-written rules. Dynamically imported when `claude auto-mode ...` runs.
 */

import { createInterface } from 'readline'
import { errorMessage } from '../../utils/errors.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
  getDefaultExternalAutoModeRules,
} from '../../utils/permissions/yoloClassifier.js'
import {
  getAutoModeConfig,
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonStringify } from '../../utils/slowOperations.js'

function writeRules(rules: AutoModeRules): void {
  process.stdout.write(jsonStringify(rules, null, 2) + '\n')
}

export function autoModeDefaultsHandler(): void {
  writeRules(getDefaultExternalAutoModeRules())
}

/**
 * Dump the effective auto mode config: user settings where provided, external
 * defaults otherwise. Per-section REPLACE semantics — matches how
 * buildYoloSystemPrompt resolves the external template (a non-empty user
 * section replaces that section's defaults entirely; an empty/absent section
 * falls through to defaults).
 */
export function autoModeConfigHandler(): void {
  const config = getAutoModeConfig()
  const defaults = getDefaultExternalAutoModeRules()
  writeRules({
    allow: config?.allow?.length ? config.allow : defaults.allow,
    soft_deny: config?.soft_deny?.length
      ? config.soft_deny
      : defaults.soft_deny,
    hard_deny: config?.hard_deny?.length
      ? config.hard_deny
      : defaults.hard_deny,
    environment: config?.environment?.length
      ? config.environment
      : defaults.environment,
  })
}

const CRITIQUE_SYSTEM_PROMPT =
  'You are an expert reviewer of auto mode classifier rules for Claude Code.\n' +
  '\n' +
  'Claude Code has an "auto mode" that uses an AI classifier to decide whether ' +
  'tool calls should be auto-approved or require user confirmation. Users can ' +
  'write custom rules in four categories:\n' +
  '\n' +
  '- **allow**: Actions the classifier should auto-approve\n' +
  '- **soft_deny**: Destructive/irreversible actions the classifier should block unless clear user intent authorizes them\n' +
  '- **hard_deny**: Security-boundary actions the classifier should block unconditionally (user intent does not clear these)\n' +
  "- **environment**: Context about the user's setup that helps the classifier make decisions\n" +
  '\n' +
  "Your job is to critique the user's custom rules for clarity, completeness, " +
  'and potential issues. The classifier is an LLM that reads these rules as ' +
  'part of its system prompt.\n' +
  '\n' +
  'For each rule, evaluate:\n' +
  '1. **Clarity**: Is the rule unambiguous? Could the classifier misinterpret it?\n' +
  "2. **Completeness**: Are there gaps or edge cases the rule doesn't cover?\n" +
  '3. **Conflicts**: Do any of the rules conflict with each other?\n' +
  '4. **Actionability**: Is the rule specific enough for the classifier to act on?\n' +
  '\n' +
  'Be concise and constructive. Only comment on rules that could be improved. ' +
  'If all rules look good, say so.'

export async function autoModeCritiqueHandler(options: {
  model?: string
}): Promise<void> {
  const config = getAutoModeConfig()
  const hasCustomRules =
    (config?.allow?.length ?? 0) > 0 ||
    (config?.soft_deny?.length ?? 0) > 0 ||
    (config?.hard_deny?.length ?? 0) > 0 ||
    (config?.environment?.length ?? 0) > 0

  if (!hasCustomRules) {
    process.stdout.write(
      'No custom auto mode rules found.\n\n' +
        'Add rules to your settings file under autoMode.{allow, soft_deny, hard_deny, environment}.\n' +
        'Run `claude auto-mode defaults` to see the default rules for reference.\n',
    )
    return
  }

  const model = options.model
    ? parseUserSpecifiedModel(options.model)
    : getMainLoopModel()

  const defaults = getDefaultExternalAutoModeRules()
  const classifierPrompt = buildDefaultExternalSystemPrompt()

  const userRulesSummary =
    formatRulesForCritique('allow', config?.allow ?? [], defaults.allow) +
    formatRulesForCritique(
      'soft_deny',
      config?.soft_deny ?? [],
      defaults.soft_deny,
    ) +
    formatRulesForCritique(
      'hard_deny',
      config?.hard_deny ?? [],
      defaults.hard_deny,
    ) +
    formatRulesForCritique(
      'environment',
      config?.environment ?? [],
      defaults.environment,
    )

  process.stdout.write('Analyzing your auto mode rules…\n\n')

  let response
  try {
    response = await sideQuery({
      querySource: 'auto_mode_critique',
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            'Here is the full classifier system prompt that the auto mode classifier receives:\n\n' +
            '<classifier_system_prompt>\n' +
            classifierPrompt +
            '\n</classifier_system_prompt>\n\n' +
            "Here are the user's custom rules that REPLACE the corresponding default sections:\n\n" +
            userRulesSummary +
            '\nPlease critique these custom rules.',
        },
      ],
    })
  } catch (error) {
    process.stderr.write(
      'Failed to analyze rules: ' + errorMessage(error) + '\n',
    )
    process.exitCode = 1
    return
  }

  const textBlock = response.content.find(block => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(textBlock.text + '\n')
  } else {
    process.stdout.write('No critique was generated. Please try again.\n')
  }
}

function confirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} [y/N] `, answer => {
      const normalized = answer.trim().toLowerCase()
      resolve(normalized === 'y' || normalized === 'yes')
      rl.close()
    })
    rl.once('close', () => resolve(false))
  })
}

/**
 * `claude auto-mode reset`: remove the autoMode section from the user settings
 * file so the shipped defaults apply again (official 2.1.2xx). Asks first
 * unless --yes. Other settings sources are left alone, like official.
 */
export async function autoModeResetHandler(options: {
  yes?: boolean
}): Promise<void> {
  const path = getSettingsFilePathForSource('userSettings')
  if (!path) {
    process.stderr.write('Could not resolve the user settings file path.\n')
    process.exitCode = 1
    return
  }
  if (getSettingsForSource('userSettings')?.autoMode === undefined) {
    process.stdout.write(
      `Auto mode configuration is already at defaults \u2014 ${path} has no autoMode section.\n`,
    )
    return
  }
  if (!options.yes && !(await confirm('Reset auto mode configuration to defaults?'))) {
    process.stderr.write('Aborted.\n')
    process.exitCode = 1
    return
  }
  const { error } = updateSettingsForSource('userSettings', {
    autoMode: undefined,
  })
  if (error) {
    process.stderr.write(`Could not reset auto mode configuration: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `Auto mode configuration reset to defaults \u2014 autoMode section removed from ${path}.\n`,
  )
}

function formatRulesForCritique(
  section: string,
  userRules: string[],
  defaultRules: string[],
): string {
  if (userRules.length === 0) return ''
  const customLines = userRules.map(r => '- ' + r).join('\n')
  const defaultLines = defaultRules.map(r => '- ' + r).join('\n')
  return (
    '## ' +
    section +
    ' (custom rules replacing defaults)\n' +
    'Custom:\n' +
    customLines +
    '\n\n' +
    'Defaults being replaced:\n' +
    defaultLines +
    '\n\n'
  )
}
