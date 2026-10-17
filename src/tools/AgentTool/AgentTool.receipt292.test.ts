import { expect, test } from 'bun:test'
import { AgentTool } from './AgentTool.js'

// Official 2.1.292 CLI receipts, with only the generated agent ID and output path normalized.
const readable = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: owned-agent (internal ID - do not mention to user. Use SendMessage with to: 'owned-agent', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: /owned/agent.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification."
const noReader = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: owned-agent (internal ID - do not mention to user. Use SendMessage with to: 'owned-agent', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nIn your own words, briefly tell the user what you launched — do not echo this tool result. Agent results will arrive in a subsequent message. If the user asks for progress, say the agent is still running."

for (const [label, canReadOutputFile, outputFile, text] of [
  ['readable transcript', true, '/owned/agent.output', readable],
  ['no readable tools', false, '/owned/agent.output', noReader],
  // Official mapper also requires a nonempty path; the async registry may omit one.
  ['missing transcript path', true, '', noReader],
] as const) {
  test(`async Agent receipt matches official instructions: ${label}`, () => {
    const data = {status: 'async_launched' as const, agentId: 'owned-agent',
      description: 'Owned task', resolvedModel: 'claude-sonnet-4-6', prompt: 'Owned prompt',
      outputFile, canReadOutputFile}
    expect(AgentTool.mapToolResultToToolResultBlockParam(data, 'toolu_owned')).toEqual({
      tool_use_id: 'toolu_owned', type: 'tool_result', content: [{type: 'text', text}],
    })
  })
}
