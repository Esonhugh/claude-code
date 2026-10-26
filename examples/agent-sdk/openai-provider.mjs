// Drive the fork with the OpenAI provider and Daybreak blue, through the official SDK.
// Needs OPENAI_API_KEY (or OPENAI_AUTH_TOKEN); OPENAI_BASE_URL is optional.
import { query } from '@anthropic-ai/claude-agent-sdk'

const run = query({
  prompt: 'Say hello.',
  options: {
    pathToClaudeCodeExecutable: process.env.CLAUDE_FORK_BIN,
    // `env` replaces the child environment, so keep PATH, HOME and the OpenAI credential.
    env: { ...process.env, CLAUDE_CODE_USE_OPENAI: '1' },
    settings: { daybreak: 'blue' },
  },
})
for await (const message of run) {
  if (message.type === 'system' && message.subtype === 'init') console.log('init model=' + message.model)
  if (message.type === 'result') console.log('result', message.subtype, message.result)
}
