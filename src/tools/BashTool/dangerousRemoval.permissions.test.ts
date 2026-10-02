import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

const childFlag = 'CLAUDE_CODE_REMOVAL_PERMISSIONS_CHILD'

if (process.env[childFlag] !== '1') {
  test('removal permissions across parser modes (isolated)', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(
            key,
          ),
      ),
    )
    for (const parserFeature of [
      undefined,
      'TREE_SITTER_BASH',
      'TREE_SITTER_BASH_SHADOW',
    ]) {
      const home = mkdtempSync(join(tmpdir(), 'cc-removal-permissions-'))
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            'test',
            '--feature=BASH_CLASSIFIER',
            '--feature=TRANSCRIPT_CLASSIFIER',
            ...(parserFeature ? [`--feature=${parserFeature}`] : []),
            '--timeout',
            '30000',
            import.meta.path,
          ],
          {
            cwd: join(import.meta.dir, '../../..'),
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
        if (code !== 0)
          throw new Error(`${parserFeature ?? 'legacy'}\n${stdout}\n${stderr}`)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  }, 180_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  const { setSessionSettingsCache } =
    await import('../../utils/settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { BashTool } = await import('./BashTool.js')
  const { hasPermissionsToUseTool } =
    await import('../../utils/permissions/permissions.js')
  const { requiresExplicitUserApproval } =
    await import('../../utils/permissions/PermissionResult.js')

  function context(permission: Partial<ToolPermissionContext> = {}) {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: {
        ...initial.toolPermissionContext,
        mode: 'bypassPermissions' as const,
        ...permission,
      },
    }
    return {
      getAppState: () => state,
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
    } as ToolUseContext
  }

  test('equivalent and composed removals reach mandatory approval through the public permission entry', async () => {
    for (const command of [
      '/bin/rm -rf ~/.config',
      'unlink ~/.zshrc.bak',
      'rmdir ~/.codex',
      'rm ~/.cache/../.config',
      'command rm ~/.codex',
      'sudo rm ~/.bashrc.bak',
      'env -C /tmp rm relative',
      'cd ~ && rm -rf .config',
      'printf %s ~/.config | xargs rm -rf',
      'find ~/.config -delete',
      'find ~/.codex -exec rm {} +',
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'composed-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
      expect(
        'pendingClassifierCheck' in result && result.pendingClassifierCheck,
      ).toBeFalsy()
    }
    for (const command of [
      'rm -rf ./dist',
      'rm -rf ~/.cache/x',
      'find ./dist -delete',
      'find ./dist -exec rm {} +',
      'command -v rm',
      'echo "rm ~/.config"',
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'ordinary-removal',
      )
      expect(result.behavior).toBe('allow')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(false)
    }
  })

  test('redirections do not hide deletion operands or turn redirect targets into operands', async () => {
    for (const command of [
      '2>/dev/null rm -rf ~/.codex',
      'rm -rf 2>/dev/null ~/.codex',
      '! rm -rf 2>/dev/null ~/.codex',
      'echo ok | rm ./dist >out ~/.codex 2>err ordinary',
      'rm <<<hello ~/.codex',
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'redirect-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    }
    for (const command of [
      '2>/dev/null rm ./dist',
      'rm >out ./dist',
      'rm ./dist > ~/.config/log',
      'echo ok >out ~/.codex',
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'redirect-ordinary',
      )
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(false)
    }
  })

  test('heredocs preserve executable pipelines and substitutions but not literal body text', async () => {
    for (const command of [
      "cat <<'EOF' | rm -rf ~/.codex\nignored\nEOF",
      'cat <<EOF\n$(rm -rf ~/.codex)\nEOF',
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'heredoc-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    }
    for (const command of [
      "cat <<'EOF'\n$(rm -rf ~/.codex)\nEOF",
      'cat <<EOF\nrm -rf ~/.codex\nEOF',
      "cat <<'EOF' | cat\nrm -rf ~/.codex\nEOF",
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'heredoc-literal',
      )
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(false)
    }
  })

  test('approval explains the protected path or unresolved target source', async () => {
    for (const [command, reason] of [
      ['rm ~/.config/file', /Protected removal target: .*\.config\/file/],
      ['rm "$TARGET"', /expansion.*\$TARGET/],
      ['cd ~; rm relative', /working directory.*relative/],
    ] as const) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'removal-reason',
      )
      expect(result).toMatchObject({
        behavior: 'ask',
        message: expect.stringMatching(reason),
      })
    }
  })

  test('mandatory removal evaluation reuses one raw syntax parse', async () => {
    const { getParserModule } = await import('../../utils/bash/bashParser.js')
    const parse = spyOn(getParserModule()!, 'parse')
    try {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command: 'rm -rf "$HOME/.config"' },
        context(),
        undefined as never,
        'single-parse-removal',
      )
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
      expect(parse).toHaveBeenCalledTimes(1)
    } finally {
      parse.mockRestore()
    }
  })

  test('mandatory approval avoids path checks when no deny rules exist', async () => {
    const paths = await import('./pathValidation.js')
    const checkPaths = spyOn(paths, 'checkPathConstraints')
    try {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command: 'rm -rf ~/.config' },
        context(),
        undefined as never,
        'no-deny-removal',
      )
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
      expect(checkPaths).not.toHaveBeenCalled()
    } finally {
      checkPaths.mockRestore()
    }
  })

  test('parser resource failure preserves mandatory approval for a direct removal', async () => {
    const { getParserModule } = await import('../../utils/bash/bashParser.js')
    const failure = spyOn(getParserModule()!, 'parse').mockReturnValue(null)
    try {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command: 'rm -rf ~/.config' },
        context(),
        undefined as never,
        'parser-aborted-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    } finally {
      failure.mockRestore()
    }
  })

  test('cancelling a deletion permission check propagates cancellation', async () => {
    const { AbortError } = await import('../../utils/errors.js')
    const ctx = context()
    ctx.abortController.abort()
    await expect(
      hasPermissionsToUseTool(
        BashTool,
        { command: 'rm -rf ~/.config' },
        ctx,
        undefined as never,
        'cancelled-removal',
      ),
    ).rejects.toBeInstanceOf(AbortError)
  })

  test('an unavailable removal checker reports an error instead of bypass allowance', async () => {
    const analyzer = await import('./dangerousRemoval.js')
    const failure = spyOn(analyzer, 'checkDangerousRemoval').mockImplementation(
      () => {
        throw new Error('injected removal failure')
      },
    )
    try {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command: 'rm -rf ~/.config' },
        context(),
        undefined as never,
        'checker-failure',
      )
      expect(result).toMatchObject({
        behavior: 'deny',
        message: expect.stringMatching(/check failed/i),
      })
    } finally {
      failure.mockRestore()
    }
  })

  test('over-length direct removal cannot bypass protection when syntax analysis is unavailable', async () => {
    const command = `rm -rf "$HOME/.config" ${'ordinary '.repeat(1200)}`
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command },
      context(),
      undefined as never,
      'over-length-removal',
    )
    expect(result.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    const ordinary = await hasPermissionsToUseTool(
      BashTool,
      { command: `echo ${'ordinary '.repeat(1200)}` },
      context(),
      undefined as never,
      'over-length-echo',
    )
    expect(requiresExplicitUserApproval(ordinary.decisionReason)).toBe(false)
  })

  test('variable removals stay mandatory across permission modes and approval shortcuts', async () => {
    const command = 'rm -rf "$HOME/.config"'
    for (const mode of [
      'default',
      'auto',
      'acceptEdits',
      'bypassPermissions',
    ] as const) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context({
          mode,
          alwaysAllowRules: { session: [`Bash(${command})`] },
        }),
        undefined as never,
        'mode-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
      expect(
        'pendingClassifierCheck' in result && result.pendingClassifierCheck,
      ).toBeFalsy()
    }
    const { SandboxManager } =
      await import('../../utils/sandbox/sandbox-adapter.js')
    const mocks = [
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true),
      spyOn(
        SandboxManager,
        'isAutoAllowBashIfSandboxedEnabled',
      ).mockReturnValue(true),
    ]
    const previous = process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
    try {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'sandbox-removal',
      )
      expect(result.behavior).toBe('ask')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    } finally {
      if (previous === undefined)
        delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
      else process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = previous
      mocks.forEach(mock => mock.mockRestore())
    }
  })

  test('quoted backslashes cannot hide a path deny behind mandatory approval', async () => {
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: "rm -rf 'literal\\\\backslash' ~/.config/denied" },
      context({
        alwaysDenyRules: { session: ['Edit(~/.config/**)'] },
      }),
      undefined as never,
      'quoted-path-denied-removal',
    )
    expect(result.behavior).toBe('deny')
  })

  test('a known file deny remains stronger than mandatory deletion approval', async () => {
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'rm -rf ~/.config' },
      context({
        alwaysDenyRules: { session: ['Edit(~/.config/**)'] },
      }),
      undefined as never,
      'path-denied-removal',
    )
    expect(result.behavior).toBe('deny')
  })

  test('file denies outrank mandatory approval for unlink and absolute removal executables', async () => {
    for (const command of [
      'unlink ~/.config/file',
      '/bin/rm -rf ~/.config/file',
      '/bin/rmdir ~/.config/nested',
      'nice /bin/rm -rf ~/.config/file',
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context({
          alwaysDenyRules: { session: ['Edit(~/.config/**)'] },
        }),
        undefined as never,
        'equivalent-path-denied-removal',
      )
      expect(result.behavior).toBe('deny')
      expect(result.decisionReason?.type).toBe('rule')
    }
  })

  test('a later explicit deny outranks a mandatory removal and a full-command allow', async () => {
    const command = 'rm -rf "$HOME/.config" && touch ./denied'
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command },
      context({
        alwaysAllowRules: { session: [`Bash(${command})`] },
        alwaysDenyRules: { session: ['Bash(touch:*)'] },
      }),
      undefined as never,
      'later-deny',
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })

  test('removal allow prefixes do not implicitly authorize xargs', async () => {
    const { bashToolCheckPermission } = await import('./bashPermissions.js')
    for (const name of ['rm', 'rmdir', 'unlink']) {
      const state = context({
        mode: 'default',
        alwaysAllowRules: { session: [`Bash(${name}:*)`] },
      }).getAppState()
      const result = bashToolCheckPermission(
        { command: `xargs ${name}` },
        state.toolPermissionContext,
      )
      expect(result.behavior).not.toBe('allow')
      const denied = context({
        alwaysDenyRules: { session: [`Bash(${name}:*)`] },
      }).getAppState()
      expect(
        bashToolCheckPermission(
          { command: `xargs ${name}` },
          denied.toolPermissionContext,
        ).behavior,
      ).toBe('deny')
    }
    const state = context({
      mode: 'default',
      alwaysAllowRules: { session: ['Bash(grep:*)'] },
    }).getAppState()
    expect(
      bashToolCheckPermission(
        { command: 'xargs grep needle' },
        state.toolPermissionContext,
      ).behavior,
    ).toBe('allow')
  })

  test('quoted tilde and wildcard targets remain literal ordinary deletions', async () => {
    for (const command of [
      "rm -rf '~/.config'",
      "rm './*'",
      'rm \\~/.codex',
      "rm '$HOME/.config'",
    ]) {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        context(),
        undefined as never,
        'literal-removal',
      )
      expect(result.behavior).toBe('allow')
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(false)
    }
  })

  test('variable removal targets require explicit approval even in bypass', async () => {
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'rm -rf "$HOME/.config"' },
      context(),
      undefined as never,
      'variable-removal',
    )
    expect(result.behavior).toBe('ask')
    expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    expect(
      'pendingClassifierCheck' in result && result.pendingClassifierCheck,
    ).toBeFalsy()
  })
}
