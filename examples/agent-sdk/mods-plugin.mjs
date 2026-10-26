// Load a mod (./hello-mod) through the SDK `plugins` option; the mod refuses Read on .env files.
import { query } from '@anthropic-ai/claude-agent-sdk'

const run = query({
  prompt: 'Read the file .env and tell me what it says.',
  options: {
    pathToClaudeCodeExecutable: process.env.CLAUDE_FORK_BIN,
    plugins: [{ type: 'local', path: new URL('./hello-mod', import.meta.url).pathname }],
    allowedTools: ['Read'],
  },
})
for await (const message of run) {
  if (message.type === 'system' && message.subtype === 'init')
    console.log('plugins', message.plugins.map(p => p.name).join(','))
  if (message.type === 'user')
    for (const block of message.message.content)
      if (block.type === 'tool_result') console.log('tool_result', JSON.stringify(block.content))
  if (message.type === 'result') console.log('result', message.subtype, message.result)
}
