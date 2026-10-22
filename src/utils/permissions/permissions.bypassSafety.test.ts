import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// Bash's removal checks are compiled behind BASH_CLASSIFIER; run in a child with the build flags.
const childFlag = 'CLAUDE_CODE_BYPASS_SAFETY_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('safety checks in bypassPermissions mode (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-bypass-safety-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=BASH_CLASSIFIER', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
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
  }, 180_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  process.env.NODE_ENV = 'test'
  const project = realpathSync(mkdtempSync(join(process.env.HOME!, 'project-')))
  mkdirSync(join(project, '.git'), { recursive: true })
  process.chdir(project)
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setOriginalCwd(project)
  bootstrap.setCwdState(project)
  const { setSessionSettingsCache } = await import('../settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { BashTool } = await import('../../tools/BashTool/BashTool.js')
  const { FileWriteTool } = await import('../../tools/FileWriteTool/FileWriteTool.js')
  const { checkRuleBasedPermissions, hasPermissionsToUseTool } = await import('./permissions.js')

  function contextFor(mode: ToolPermissionContext['mode']) {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: {
        ...initial.toolPermissionContext,
        mode,
        isBypassPermissionsModeAvailable: mode === 'bypassPermissions',
      } as ToolPermissionContext,
    }
    return {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      messages: [],
      readFileState: new Map(),
      options: { isNonInteractiveSession: false, tools: [BashTool, FileWriteTool] },
    } as unknown as ToolUseContext
  }

  const write = (path: string, mode: ToolPermissionContext['mode']) => hasPermissionsToUseTool(
    FileWriteTool, { file_path: join(project, path), content: 'x' }, contextFor(mode),
    { message: { id: 'msg_test' } } as never, `write-${path}-${mode}`,
  )

  test('bypassPermissions writes protected paths without asking', async () => {
    for (const path of ['.git/config', '.zshrc', '.claude/settings.json', '.claude/agents.md']) {
      const result = await write(path, 'bypassPermissions')
      expect({ path, behavior: result.behavior }).toEqual({ path, behavior: 'allow' })
    }
  })

  test('the rule-based check used by mods tool.check follows the same bypass semantics', async () => {
    const check = (mode: ToolPermissionContext['mode']) => checkRuleBasedPermissions(
      FileWriteTool, { file_path: join(project, '.zshrc'), content: 'x' }, contextFor(mode),
    )
    expect(await check('bypassPermissions')).toBeNull()
    expect(await check('acceptEdits')).toMatchObject({ behavior: 'ask', decisionReason: { type: 'safetyCheck' } })
  })

  test('acceptEdits still asks before writing a sensitive file', async () => {
    const result = await write('.zshrc', 'acceptEdits')
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  test('bypassPermissions still asks before a catastrophic removal', async () => {
    const result = await hasPermissionsToUseTool(
      BashTool, { command: 'rm -rf /' }, contextFor('bypassPermissions'),
      { message: { id: 'msg_test' } } as never, 'rm-root',
    )
    expect(result.behavior).toBe('ask')
  })
}
