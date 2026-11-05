import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'

const childFlag = 'CLAUDE_CODE_SDK_CONTROL_REQUESTS_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('newer Agent SDK control requests (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-sdk-control-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=UDS_INBOX', '--feature=KAIROS_CHANNELS', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      console.log(`${stdout}\n${stderr}`.match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { runHeadless } = await import('./print.js')
  const { StructuredIO } = await import('./structuredIO.js')
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const { onChangeAppState } = await import('../state/onChangeAppState.js')
  const grove = await import('../services/api/grove.js')
  const growthbook = await import('../services/analytics/growthbook.js')
  const env = await import('../utils/envUtils.js')
  const shutdown = await import('../utils/gracefulShutdown.js')
  const processUtils = await import('../utils/process.js')
  const stdoutGuard = await import('../utils/streamJsonStdoutGuard.js')
  const modelStrings = await import('../utils/model/modelStrings.js')
  const toolPool = await import('../tools.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  const { readFileSync } = await import('node:fs')

  async function run(requests: Record<string, unknown>[], store = createStore(getDefaultAppState(), onChangeAppState)) {
    const frames: StdoutMessage[] = []
    const receipts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const mocks = [
      spyOn(grove, 'isQualifiedForGrove').mockResolvedValue(false),
      spyOn(growthbook, 'initializeGrowthBook').mockResolvedValue(undefined),
      spyOn(env, 'isBareMode').mockReturnValue(true),
      spyOn(shutdown, 'gracefulShutdownSync').mockImplementation(() => {}),
      spyOn(processUtils, 'registerProcessOutputErrorHandlers').mockImplementation(() => {}),
      spyOn(stdoutGuard, 'installStreamJsonStdoutGuard').mockImplementation(() => () => {}),
      spyOn(modelStrings, 'ensureModelStringsInitialized').mockResolvedValue(undefined),
      spyOn(toolPool, 'assembleToolPool').mockReturnValue([]),
      spyOn(SandboxManager, 'getSandboxUnavailableReason').mockReturnValue(undefined),
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(false),
      spyOn(StructuredIO.prototype, 'write').mockImplementation(async message => {
        frames.push(message)
        if (message.type === 'control_response') receipts.get(message.response.request_id)?.resolve()
      }),
    ]
    async function* input() {
      for (const [i, request] of requests.entries()) {
        receipts.set(String(i), Promise.withResolvers<void>())
        yield JSON.stringify({ type: 'control_request', request_id: String(i), request }) + '\n'
        await receipts.get(String(i))!.promise
      }
    }
    try {
      await runHeadless(input(), store.getState, store.setState, [], [], {}, [], {
        outputFormat: 'stream-json', verbose: true, sessionStartHooksPromise: Promise.resolve([]),
      } as Parameters<typeof runHeadless>[7])
    } finally {
      for (const mock of mocks) mock.mockRestore()
    }
    return frames.filter(frame => frame.type === 'control_response').map(frame => frame.response as Record<string, any>)
  }

  test('send_task_message routes like typing into an agent view; get_task_output reads a Terminal screen', async () => {
    const base = { description: 'd', startTime: 0, outputFile: '/dev/null', outputOffset: 0, notified: false }
    const initial = getDefaultAppState()
    const store = createStore({
      ...initial,
      tasks: {
        a1: { ...base, id: 'a1', type: 'local_agent', status: 'running', agentId: 'a1', prompt: 'p', messages: [], pendingMessages: [] },
        a2: { ...base, id: 'a2', type: 'local_agent', status: 'killed', agentId: 'a2', prompt: 'p', messages: [], pendingMessages: [], stoppedByUser: true },
        t1: { ...base, id: 't1', type: 'in_process_teammate', status: 'running', identity: { agentId: 'alice@team', resumableAgentId: 'aalice-1' }, messages: [], pendingUserMessages: [] },
        t2: { ...base, id: 't2', type: 'in_process_teammate', status: 'completed', messages: [], pendingUserMessages: [] },
        term1: { ...base, id: 'term1', type: 'interactive_terminal', status: 'running', sessionId: 's', command: 'bash', args: [], cwd: '/', cols: 80, rows: 24, preview: '$ echo hi\nhi', closed: false },
      } as unknown as typeof initial.tasks,
    }, onChangeAppState)
    const [queued, stopped, injected, teammateGone, unknown, empty, screen] = await run([
      { subtype: 'send_task_message', task_id: 'a1', text: 'also check the appendix' },
      { subtype: 'send_task_message', task_id: 'a2', text: 'x' },
      { subtype: 'send_task_message', task_id: 't1', text: 'hello teammate' },
      { subtype: 'send_task_message', task_id: 't2', text: 'x' },
      { subtype: 'send_task_message', task_id: 'nosuch', text: 'x' },
      { subtype: 'send_task_message', task_id: 'a1', text: '  ' },
      { subtype: 'get_task_output', task_id: 'term1' },
    ], store)
    expect(queued.response).toEqual({ delivery: 'queued' })
    const tasks = store.getState().tasks as Record<string, any>
    expect(tasks.a1.pendingMessages).toEqual([{ text: 'also check the appendix', fromUser: true }])
    // Shown in its view from the queue until the agent reads it (#825).
    expect(tasks.a1.messages).toHaveLength(0)
    expect(stopped).toMatchObject({ subtype: 'error', error: 'send_task_message: agent a2 was stopped by the user' })
    // A teammate's transcript is named by its agent id, which the web server keys sends by (#826).
    expect(injected.response).toEqual({ delivery: 'injected', agent_id: 'aalice-1' })
    expect(tasks.t1.pendingUserMessages).toEqual(['hello teammate'])
    expect(teammateGone).toMatchObject({ subtype: 'error', error: 'send_task_message: teammate has stopped; message was not sent' })
    expect(unknown).toMatchObject({ subtype: 'error', error: 'send_task_message: no agent or teammate task' })
    expect(empty).toMatchObject({ subtype: 'error', error: 'send_task_message: task_id and text must be non-empty strings' })
    expect(screen.response).toEqual({ output: '$ echo hi\nhi', total_bytes: 12, truncated: false })
  })

  test('fork terminal requests: screen format, background task listing and send_terminal_input validation', async () => {
    const { createMonitorEventStream } = await import('../tools/MonitorTool/monitorEvents.js')
    const events = createMonitorEventStream({ taskRef: { id: 'm1' }, description: 'watch', killTask: () => false, now: () => 1000, notify: () => {} })
    events.onData('epoch 1 done\n')
    events.flush()
    const base = { description: 'd', startTime: 0, outputFile: '/dev/null', outputOffset: 0, notified: false }
    const shell = { completionStatusSentInAttachment: false, shellCommand: null, lastReportedTotalLines: 0, isBackgrounded: true }
    const initial = getDefaultAppState()
    const store = createStore({
      ...initial,
      tasks: {
        term1: { ...base, id: 'term1', type: 'interactive_terminal', status: 'running', sessionId: 'term-9', command: '/usr/bin/python3', args: ['-q'], requestedCommand: 'python3 -q', cwd: '/', cols: 80, rows: 24, preview: '>>> 1+1\n\n2', closed: false, agentId: 'a1' },
        term2: { ...base, id: 'term2', type: 'interactive_terminal', status: 'completed', endTime: 5000, sessionId: 'term-8', command: 'bash', args: [], cwd: '/', cols: 80, rows: 24, preview: '', closed: true, exitCode: 0 },
        b1: { ...base, ...shell, id: 'b1', type: 'local_bash', status: 'running', command: 'sleep 300', kind: 'bash' },
        m1: { ...base, ...shell, id: 'm1', type: 'local_bash', status: 'killed', endTime: 2000, command: 'tail -f log', description: 'watch', kind: 'monitor', result: { code: 143, interrupted: true } },
        a1: { ...base, id: 'a1', type: 'local_agent', status: 'running', agentId: 'a1', prompt: 'p', messages: [], pendingMessages: [] },
      } as unknown as typeof initial.tasks,
    }, onChangeAppState)
    const [screen, badFormat, listing, noTask, emptyInput, badKey, longText, notTerminal, ended] = await run([
      { subtype: 'get_task_output', task_id: 'term1', format: 'screen' },
      { subtype: 'get_task_output', task_id: 'term1', format: 'ansi' },
      { subtype: 'get_background_tasks' },
      { subtype: 'send_terminal_input', text: 'x' },
      { subtype: 'send_terminal_input', task_id: 'term1', text: '' },
      { subtype: 'send_terminal_input', task_id: 'term1', key: 'F1' },
      { subtype: 'send_terminal_input', task_id: 'term1', text: 'x'.repeat(4097) },
      { subtype: 'send_terminal_input', task_id: 'b1', text: 'x' },
      { subtype: 'send_terminal_input', task_id: 'term2', enter: true },
    ], store)
    // No PTY session behind it: the plain preview lines stand in for the screen.
    expect(screen.response).toEqual({
      output: '>>> 1+1\n\n2',
      total_bytes: 10,
      truncated: false,
      screen: { cols: 80, rows: 24, lines: [[{ text: '>>> 1+1' }], [], [{ text: '2' }]] },
    })
    expect(badFormat).toMatchObject({ subtype: 'error', error: 'get_task_output: format must be "screen" when given' })
    const byId = Object.fromEntries((listing.response.tasks as { task_id: string }[]).map(t => [t.task_id, t]))
    expect(Object.keys(byId).sort()).toEqual(['b1', 'm1', 'term1', 'term2'])
    expect(byId.term1).toMatchObject({ task_type: 'interactive_terminal', command: 'python3 -q', cols: 80, rows: 24, agent_id: 'a1', status: 'running' })
    expect(byId.term2).toMatchObject({ command: 'bash', exit_code: 0, duration_ms: 5000 })
    expect(byId.b1).toMatchObject({ task_type: 'local_bash', kind: 'bash', command: 'sleep 300', tail: '' })
    expect(byId.m1).toMatchObject({ kind: 'monitor', exit_code: 143, duration_ms: 2000, events: [{ time: 1000, text: 'epoch 1 done' }] })
    const shape = 'send_terminal_input: task_id must be a non-empty string, with text (at most 4096 characters), a key, or enter: true'
    for (const bad of [noTask, emptyInput, badKey, longText]) expect(bad).toMatchObject({ subtype: 'error', error: shape })
    for (const bad of [notTerminal, ended]) {
      expect(bad).toMatchObject({ subtype: 'error', error: 'send_terminal_input: no running terminal with that task_id' })
    }
  })

  test('reload_skills and reload_output_styles answer instead of Unsupported', async () => {
    const [skills, styles] = await run([{ subtype: 'reload_skills' }, { subtype: 'reload_output_styles' }])
    expect(skills.subtype).toBe('success')
    expect(Array.isArray(skills.response.skills)).toBe(true)
    expect(styles.subtype).toBe('success')
    expect(styles.response.available_output_styles).toContain('default')
  })

  test('set_max_thinking_tokens accepts display-only requests and rejects bad values', async () => {
    const responses = await run([
      { subtype: 'set_max_thinking_tokens', thinking_display: 'summarized' },
      { subtype: 'set_max_thinking_tokens', max_thinking_tokens: null, thinking_display: null },
      { subtype: 'set_max_thinking_tokens', max_thinking_tokens: 1.5 },
      { subtype: 'set_max_thinking_tokens', thinking_display: 'verbose' },
    ])
    expect(responses.map(r => r.subtype)).toEqual(['success', 'success', 'error', 'error'])
    expect(responses[3].error).toContain('thinking_display must be one of summarized, omitted, highlights')
  })

  test('read_file uses the Read permission gate, max_bytes and base64', async () => {
    const [text, cut, b64, outside, missing] = await run([
      { subtype: 'read_file', path: 'package.json' },
      { subtype: 'read_file', path: 'package.json', max_bytes: 5 },
      { subtype: 'read_file', path: 'package.json', max_bytes: 3, encoding: 'base64' },
      { subtype: 'read_file', path: '/etc/hostname' },
      { subtype: 'read_file' },
    ])
    expect(text.subtype).toBe('success')
    expect(text.response.contents).toBe(readFileSync('package.json', 'utf-8'))
    expect(text.response.absPath).toBe(join(process.cwd(), 'package.json'))
    expect(text.response.truncated).toBeUndefined()
    expect(cut.response).toMatchObject({ contents: readFileSync('package.json', 'utf-8').slice(0, 5), truncated: true })
    expect(b64.response).toMatchObject({ contents: readFileSync('package.json').subarray(0, 3).toString('base64'), encoding: 'base64' })
    expect(outside).toMatchObject({ subtype: 'error', error: 'read_file: permission denied for /etc/hostname' })
    expect(missing).toMatchObject({ subtype: 'error', error: 'read_file: path is required' })
  })

  test('update_settings writes only the allowlisted key', async () => {
    const responses = await run([
      { subtype: 'update_settings', source: 'userSettings', settings: { effortLevel: 'low' } },
      { subtype: 'update_settings', source: 'userSettings', settings: { effortLevel: 'max' } },
      { subtype: 'update_settings', source: 'userSettings', settings: { permissions: { allow: ['Bash'] } } },
      { subtype: 'update_settings', source: 'policySettings', settings: { outputStyle: 'x' } },
      { subtype: 'update_settings', source: 'localSettings', settings: { outputStyle: 'x', model: 'y' } },
    ])
    expect(responses.map(r => r.subtype)).toEqual(['success', 'error', 'error', 'error', 'error'])
    const saved = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf-8'))
    expect(saved).toEqual({ effortLevel: 'low' })
  })

  // Official 2.1.303 treats stopping a task that is gone or already finished as done.
  test('stop_task answers success for an unknown task id', async () => {
    const [unknown, invalid] = await run([
      { subtype: 'stop_task', task_id: 'nosuch' },
      { subtype: 'stop_task', task_id: 7 },
    ])
    expect(unknown).toMatchObject({ subtype: 'success' })
    expect(invalid).toMatchObject({ subtype: 'error', error: 'stop_task: task_id must be a string' })
  })

  test('mcp_read_resource only reads ui:// resources from known servers', async () => {
    const [scheme, unknown] = await run([
      { subtype: 'mcp_read_resource', serverName: 'nosuch', uri: 'file:///etc/passwd' },
      { subtype: 'mcp_read_resource', serverName: 'nosuch', uri: 'ui://widget' },
    ])
    expect(scheme).toMatchObject({ subtype: 'error', error: 'mcp_read_resource: uri must use the ui:// scheme' })
    expect(unknown).toMatchObject({ subtype: 'error', error: 'mcp_read_resource: no connected server named nosuch' })
  })

  test('host UI requests from the VS Code extension answer instead of Unsupported', async () => {
    const usage = await import('../services/api/usage.js')
    const utilization = spyOn(usage, 'fetchUtilization').mockResolvedValue(null)
    try {
      const [status, usageRes, cost, version, models, files, plan, exported, rename, renameOther, paused] = await run([
        { subtype: 'get_status' },
        { subtype: 'get_usage', skip_behaviors: true },
        { subtype: 'get_session_cost' },
        { subtype: 'get_binary_version' },
        { subtype: 'list_models' },
        { subtype: 'file_suggestions', query: '' },
        { subtype: 'get_plan' },
        { subtype: 'export_conversation' },
        { subtype: 'rename_session', title: 'host title', source: 'host' },
        { subtype: 'rename_session', title: 'x', session_id: 'another-session' },
        { subtype: 'set_prompt_suggestions_paused', paused: true },
      ])
      expect(status.subtype).toBe('success')
      expect(status.response.sections.map((s: { title: string }) => s.title).slice(0, 2)).toEqual(['Session', 'Environment'])
      expect(status.response.sections[0].rows[0]).toEqual({ label: 'Version', value: 'test' })
      for (const section of status.response.sections) {
        for (const row of section.rows) expect(typeof row.value).toBe('string')
      }
      expect(usageRes.response).toMatchObject({
        session: { total_cost_usd: 0, total_lines_added: 0, model_usage: {} },
        rate_limits_available: false,
        rate_limits: null,
        behaviors: null,
      })
      expect(cost.response.text).toContain('Total cost:')
      expect(cost.response.text).not.toContain('\u001b[')
      expect(version.response).toEqual({ version: 'test' })
      expect(models.response.models.length).toBeGreaterThan(0)
      expect(models.response.models[0]).toMatchObject({ value: expect.any(String), resolvedModel: expect.any(String) })
      expect(files.subtype).toBe('success')
      expect(files.response.cwd).toBe(process.cwd())
      expect(Array.isArray(files.response.suggestions)).toBe(true)
      expect(plan.response).toEqual({ exists: false })
      expect(exported.response).toMatchObject({ text: expect.any(String), default_filename: expect.stringMatching(/^conversation-.*\.txt$/) })
      expect(rename.subtype).toBe('success')
      expect(renameOther).toMatchObject({ subtype: 'error', error: 'rename_session: this process has moved to another session' })
      expect(paused.subtype).toBe('success')
    } finally {
      utilization.mockRestore()
    }
  })

  test('get_usage reports ChatGPT plan windows by their length', async () => {
    const usage = await import('../services/api/usage.js')
    const utilization = spyOn(usage, 'fetchUtilization').mockResolvedValue({
      source: 'chatgpt',
      plan_type: 'plus',
      five_hour: null,
      seven_day: { utilization: 12, resets_at: '2026-10-24T20:00:00.000Z', window_minutes: 300 },
      seven_day_sonnet: { utilization: 40, resets_at: '2026-10-30T00:00:00.000Z', window_minutes: 10080 },
      chatgpt_limits: [{ title: '5h limit', limit: { utilization: 12, resets_at: '2026-10-24T20:00:00.000Z' } }],
    })
    try {
      const [res] = await run([{ subtype: 'get_usage' }])
      expect(res.response).toMatchObject({
        subscription_type: 'plus',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: '2026-10-24T20:00:00.000Z' },
          seven_day: { utilization: 40, resets_at: '2026-10-30T00:00:00.000Z' },
          model_scoped: [{ display_name: '5h limit', utilization: 12, resets_at: '2026-10-24T20:00:00.000Z' }],
        },
      })
    } finally {
      utilization.mockRestore()
    }
  })

  test('host dialog requests (memory, skills, sandbox, hooks, permissions, diff, tasks, feedback) answer', async () => {
    const [memory, skills, sandbox, hooks, rules, diff, taskOut, endedTask, bgAll, bgOne, rated, badRating, badCleared, feedback] = await run([
      { subtype: 'get_memory_dialog' },
      { subtype: 'get_skills_dialog' },
      { subtype: 'get_sandbox_dialog' },
      { subtype: 'get_hooks_listing' },
      { subtype: 'list_permission_rules' },
      { subtype: 'get_workspace_diff' },
      { subtype: 'get_task_output', task_id: 'nosuch' },
      { subtype: 'get_task_output', task_id: 'b00000000' },
      { subtype: 'background_tasks' },
      { subtype: 'background_tasks', tool_use_id: 'toolu_nosuch' },
      { subtype: 'message_rated', messageUuid: 'm1', sentiment: 'positive' },
      { subtype: 'message_rated', messageUuid: 'm1', sentiment: 'meh' },
      { subtype: 'message_rated', messageUuid: 'm1', sentiment: 'positive', cleared: 'yes' },
      { subtype: 'submit_feedback', description: 'x' },
    ])
    expect(memory.subtype).toBe('success')
    expect(memory.response.files.slice(0, 2).map((f: { kind: string }) => f.kind)).toEqual(['user', 'project'])
    expect(memory.response.files[0]).toMatchObject({ label: 'User instructions', description: 'Saved in ~/.claude/CLAUDE.md' })
    expect(memory.response.auto_memory).toMatchObject({ enabled: expect.any(Boolean), status: expect.stringMatching(/^(on|off)$/) })
    expect(skills.subtype).toBe('success')
    expect(Array.isArray(skills.response.skills)).toBe(true)
    expect(sandbox.subtype).toBe('success')
    expect(sandbox.response).toMatchObject({
      locked: false,
      enabled: false,
      enabled_in_settings: false,
      mode: 'disabled',
      unsandboxed_fallback: true,
      excluded_commands: [],
      dependencies: { errors: expect.any(Array), warnings: expect.any(Array) },
      restrictions: { fs_allow_read: [], fs_allow_write: [], network_managed: false, unix_sockets: [] },
    })
    expect(hooks.response).toMatchObject({ events: [], hooks: [], policy: { disabledByPolicy: false } })
    expect(hooks.response).not.toHaveProperty('safeMode')
    expect(hooks.response.eventCatalog[0]).toEqual({ name: 'PreToolUse', summary: 'Before tool execution', supportsMatcher: true })
    expect(rules.response.state).toMatchObject({ workspaceDirectories: [], originalCwd: expect.any(String), managedOnly: false })
    expect(Array.isArray(rules.response.state.rules)).toBe(true)
    expect(diff.subtype).toBe('success')
    expect(diff.response).toHaveProperty('diff')
    expect(taskOut).toMatchObject({ subtype: 'error', error: 'get_task_output: no shell or Monitor task with that task_id in this session' })
    expect(endedTask.response).toEqual({ output: '', total_bytes: 0, truncated: false })
    expect(bgAll.response).toEqual({})
    expect(bgOne.response).toEqual({ backgrounded: false })
    expect(rated.response).toEqual({})
    expect(badRating.subtype).toBe('error')
    expect(badCleared).toMatchObject({ subtype: 'error', error: expect.stringContaining('and cleared a boolean') })
    expect(feedback.response).toMatchObject({ feedback_id: null, unavailable_reason: expect.any(String) })
  })
}
