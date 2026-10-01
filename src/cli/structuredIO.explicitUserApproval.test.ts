import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'

const childFlag = 'CLAUDE_CODE_STRUCTURED_IO_EXPLICIT_APPROVAL_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('structured IO explicit approval (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-structured-io-approval-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(
            key,
          ),
      ),
    )
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        {
          cwd: join(import.meta.dir, '../..'),
          env: {
            ...env,
            [childFlag]: '1',
            HOME: home,
            CLAUDE_CONFIG_DIR: home,
            ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
            DISABLE_TELEMETRY: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  process.env.NODE_ENV = 'test'

  const hooks = await import('../utils/hooks.js')
  const permissionHook = spyOn(
    hooks,
    'executePermissionRequestHooks',
  ).mockImplementation(async function* () {
    yield {
      permissionRequestResult: {
        behavior: 'allow' as const,
        updatedInput: { command: 'hook-approved' },
      },
    }
  })
  const { StructuredIO } = await import('./structuredIO.js')

  test('waits for SDK human approval without running permission hooks', async () => {
    const structuredIO = new StructuredIO({
      async *[Symbol.asyncIterator]() {
        yield* []
      },
    })
    structuredIO.setOnControlRequestSent((request) => {
      setTimeout(() => {
        structuredIO.injectControlResponse({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
            response: {
              behavior: 'allow',
              updatedInput: { command: 'manually approved' },
              toolUseID: 'tool-use-id',
            },
          },
        })
      }, 25)
    })

    const tool = {
      name: 'Bash',
      userFacingName: () => 'Bash',
    } as unknown as Tool
    const abortController = new AbortController()
    const toolUseContext = {
      abortController,
      getAppState: () => ({
        toolPermissionContext: { mode: 'bypassPermissions' },
      }),
      setAppState: () => {},
    } as unknown as ToolUseContext

    const decision = await structuredIO.createCanUseTool()(
      tool,
      { command: 'rm -rf /' },
      toolUseContext,
      {} as AssistantMessage,
      'tool-use-id',
      {
        behavior: 'ask',
        message: 'Removal requires explicit approval',
        decisionReason: {
          type: 'safetyCheck',
          reason: 'Removal requires explicit approval',
          classifierApprovable: false,
        },
      },
    )

    expect(permissionHook).not.toHaveBeenCalled()
    expect(decision.behavior).toBe('allow')
    expect(decision.behavior === 'allow' && decision.updatedInput).toEqual({
      command: 'manually approved',
    })
    expect(decision.decisionReason?.type).toBe('permissionPromptTool')
  })
}
