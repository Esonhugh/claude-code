// Run one task through the official Agent SDK, using this fork's binary.
import { query } from '@anthropic-ai/claude-agent-sdk'

const run = query({
  prompt: 'List the files here.',
  options: {
    pathToClaudeCodeExecutable: process.env.CLAUDE_FORK_BIN,
    allowedTools: ['Bash(ls)'],
  },
})
for await (const message of run) {
  if (message.type === 'system' && message.subtype === 'init')
    console.log('init', message.claude_code_version, 'model=' + message.model)
  if (message.type === 'result') console.log('result', message.subtype, message.result)
}
