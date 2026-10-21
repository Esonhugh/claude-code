import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'

const childFlag = 'CLAUDE_CODE_STRUCTURED_IO_RECHECK_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('structured IO recheck after a mode change (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-structured-io-recheck-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--timeout', '30000', import.meta.path], {
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  process.env.NODE_ENV = 'test'

  const hooks = await import('../utils/hooks.js')
  spyOn(hooks, 'executePermissionRequestHooks').mockImplementation(async function* () {})
  const permissions = await import('../utils/permissions/permissions.js')
  let fresh: PermissionDecision = { behavior: 'ask', message: 'Write needs approval' }
  spyOn(permissions, 'hasPermissionsToUseTool').mockImplementation(async () => fresh)
  const { StructuredIO } = await import('./structuredIO.js')

  const tool = { name: 'Write', userFacingName: () => 'Write' } as unknown as Tool
  const toolUseContext = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    setAppState: () => {},
  } as unknown as ToolUseContext

  async function pendingAsk() {
    const structuredIO = new StructuredIO({ async *[Symbol.asyncIterator]() { yield* [] } })
    const written: { type: string; request_id?: string }[] = []
    let sentRequestId: string | undefined
    structuredIO.setOnControlRequestSent(request => { sentRequestId = request.request_id })
    const drain = (async () => {
      for await (const message of structuredIO.outbound) written.push(message as never)
    })()
    fresh = { behavior: 'ask', message: 'Write needs approval' }
    let decision: PermissionDecision | undefined
    void structuredIO.createCanUseTool()(
      tool, { file_path: 'a.ts' }, toolUseContext, {} as AssistantMessage, 'toolu_sdk',
    ).then(result => { decision = result })
    for (let i = 0; i < 20 && !sentRequestId; i++) await new Promise(r => setTimeout(r, 5))
    return {
      structuredIO, written, drain,
      requestId: () => sentRequestId,
      decision: () => decision,
      async settle() { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5)) },
    }
  }

  test('set_permission_mode approves a pending can_use_tool the new mode allows', async () => {
    const h = await pendingAsk()
    expect(h.requestId()).toBeDefined()
    fresh = { behavior: 'allow', updatedInput: { file_path: 'a.ts' }, decisionReason: { type: 'mode', mode: 'acceptEdits' } }
    h.structuredIO.recheckPendingPermissions()
    await h.settle()
    expect(h.decision()?.behavior).toBe('allow')
    expect(h.written).toContainEqual(expect.objectContaining({ type: 'control_cancel_request', request_id: h.requestId() }))
  })

  test('a classifier allow does not approve a pending can_use_tool', async () => {
    const h = await pendingAsk()
    fresh = {
      behavior: 'allow', updatedInput: { file_path: 'a.ts' },
      decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'looks fine' },
    }
    h.structuredIO.recheckPendingPermissions()
    await h.settle()
    expect(h.decision()).toBeUndefined()
  })
}
