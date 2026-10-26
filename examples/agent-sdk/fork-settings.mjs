// Turn on fork-only features with the SDK `settings` option, then check the tools the session got.
import { query } from '@anthropic-ai/claude-agent-sdk'

const run = query({
  prompt: 'Say hello.',
  options: {
    pathToClaudeCodeExecutable: process.env.CLAUDE_FORK_BIN,
    settings: {
      memory: { sqlite: { enabled: true } },
      enableWorkflows: true,
      workflowSizeGuideline: 'small',
    },
  },
})
for await (const message of run) {
  if (message.type === 'system' && message.subtype === 'init')
    console.log('tools', message.tools.filter(t => ['SearchMemory', 'Workflow'].includes(t)).join(','))
  if (message.type === 'result') console.log('result', message.subtype, message.result)
}
