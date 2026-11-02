import { expect, test } from 'bun:test'
import { AgentTool } from './AgentTool.js'

// Official 2.1.292 CLI receipts, with only the generated agent ID and output path normalized.
const readable = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: owned-agent (internal ID - do not mention to user. Use SendMessage with to: 'owned-agent', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: /owned/agent.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification."
const noReader = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: owned-agent (internal ID - do not mention to user. Use SendMessage with to: 'owned-agent', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\nIn your own words, briefly tell the user what you launched — do not echo this tool result. Agent results will arrive in a subsequent message. If the user asks for progress, say the agent is still running."

// Official 2.1.311 teammate receipt: the resumable agent id, no team name.
test('teammate spawn receipt reports the resumable agent id like official', () => {
  const data = {status: 'teammate_spawned' as const, prompt: 'Run the timer', teammate_id: 'gamma@session-12345678',
    agent_id: 'agamma-0123456789abcdef', name: 'gamma', team_name: 'session-12345678',
    tmux_session_name: 'in-process', tmux_window_name: 'in-process', tmux_pane_id: 'in-process'}
  expect(AgentTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_mate')).toEqual({
    tool_use_id: 'toolu_mate', type: 'tool_result', content: [{type: 'text', text:
      "Spawned successfully. (This tool result is internal metadata — never quote or paste any part of it, including the ID below, into a user-facing reply.)\nagent_id: agamma-0123456789abcdef\nname: gamma\nThe agent is now running and will receive instructions via mailbox."}],
  })
})

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

// Official 2.1.311: canContinueAgent (SendMessage available) gates the continue hints.
test('async and completed receipts drop the SendMessage hint when the agent cannot be continued', () => {
  const asyncText = (canContinueAgent: boolean) => (AgentTool.mapToolResultToToolResultBlockParam({status: 'async_launched' as const,
    agentId: 'owned-agent', description: 'd', resolvedModel: 'm', prompt: 'p', outputFile: '', canReadOutputFile: false, canContinueAgent}, 't').content as {text: string}[])[0]!.text
  expect(asyncText(true)).toContain("(internal ID - do not mention to user. Use SendMessage with to: 'owned-agent', summary: '<5-10 word recap>' to continue this agent.)")
  expect(asyncText(false)).toContain('agentId: owned-agent (internal ID - do not mention to user.)\n')
  const done = (canContinueAgent: boolean) => (AgentTool.mapToolResultToToolResultBlockParam({status: 'completed' as const, prompt: 'p',
    agentId: 'owned-agent', agentType: 'general-purpose', content: [{type: 'text', text: 'ok'}], totalToolUseCount: 1, totalDurationMs: 2,
    totalTokens: 3, usage: {} as never, canContinueAgent} as never, 't').content as {text: string}[]).at(-1)!.text
  expect(done(true)).toStartWith("agentId: owned-agent (use SendMessage with to: 'owned-agent', summary: '<5-10 word recap>' to continue this agent)\n<usage>")
  expect(done(false)).toStartWith('agentId: owned-agent\n<usage>')
})
