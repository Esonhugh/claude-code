import assert from 'node:assert/strict'
import test from 'node:test'

import { getPrompt } from './prompt.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

test('Agent prompt warns not to use team_name for plugin subagents', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-api-key'
  const prompt = await getPrompt([GENERAL_PURPOSE_AGENT])

  assert.match(prompt, /Do not set `team_name` for plugin or specialized subagents/)
  assert.match(prompt, /`subagent_type` values like `plugin-name:agent-name` are agent types, not team names/)
})
