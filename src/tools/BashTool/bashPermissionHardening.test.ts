import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

const childFlag = 'CLAUDE_CODE_BASH_HARDENING_CHILD'

if (process.env[childFlag] !== '1') {
  test('bash permission hardening across parser modes (isolated)', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(
            key,
          ),
      ),
    )
    for (const parserFeature of [undefined, 'TREE_SITTER_BASH']) {
      const home = mkdtempSync(join(tmpdir(), 'cc-bash-hardening-'))
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
  const { setOriginalCwd, setCwdState } = await import('../../bootstrap/state.js')

  const project = mkdtempSync(join(tmpdir(), 'cc-bash-hardening-project-'))
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, '.env'), 'X=1')
  writeFileSync(join(project, 'src/x.ts'), 'a')
  setOriginalCwd(project)
  setCwdState(project)
  process.chdir(project)

  type Rules = { allow?: string[]; deny?: string[]; ask?: string[] }
  function context(
    mode: ToolPermissionContext['mode'],
    rules: Rules = {},
  ): ToolUseContext {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: {
        ...initial.toolPermissionContext,
        mode,
        alwaysAllowRules: { session: rules.allow ?? [] },
        alwaysDenyRules: { session: rules.deny ?? [] },
        alwaysAskRules: { session: rules.ask ?? [] },
      },
    }
    return {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false, tools: [] },
      readFileState: new Map(),
    } as unknown as ToolUseContext
  }

  async function decide(
    command: string,
    mode: ToolPermissionContext['mode'],
    rules: Rules = {},
  ) {
    return hasPermissionsToUseTool(
      BashTool,
      { command },
      context(mode, rules),
      undefined as never,
      'bash-hardening',
    )
  }

  async function expectBehavior(
    command: string,
    mode: ToolPermissionContext['mode'],
    rules: Rules,
    behavior: 'allow' | 'ask' | 'deny',
  ) {
    const result = await decide(command, mode, rules)
    expect({ command, mode, behavior: result.behavior }).toEqual({
      command,
      mode,
      behavior,
    })
    return result
  }

  test('Bash deny rules see through exec wrappers in default and bypass modes', async () => {
    const rules = { deny: ['Bash(rm:*)'] }
    for (const mode of ['default', 'bypassPermissions'] as const) {
      for (const command of [
        'sudo rm -rf build',
        'sudo -u root rm -rf build',
        'doas rm -rf build',
        'env rm -rf build',
        'env -i FOO=1 rm -rf build',
        'setsid rm -rf build',
        'watch rm -rf build',
        'watch -n 1 rm -rf build',
        'ionice rm -rf build',
        'ionice -c 3 rm -rf build',
        'chrt 10 rm -rf build',
        'taskset -c 0 rm -rf build',
        'flock /tmp/lock rm -rf build',
        'command rm -rf build',
        'exec rm -rf build',
        'nohup rm -rf build',
        'sudo env FOO=1 nice rm -rf build',
        'TZ="$HOME" rm -rf build',
      ]) {
        await expectBehavior(command, mode, rules, 'deny')
      }
    }
    for (const command of ['sudo ls', 'echo rm -rf build', 'command -v rm']) {
      const result = await decide(command, 'default', rules)
      expect({ command, behavior: result.behavior }).not.toEqual({
        command,
        behavior: 'deny',
      })
    }
  })

  test('bypass mode still asks for a dangerous rm inside a shell -c script', async () => {
    for (const command of [
      "sh -c 'rm -rf /'",
      "bash -c 'rm -rf ~'",
      'zsh -c "rm -rf ~"',
      "bash -lc 'cd /tmp; rm -rf /'",
      "sh -c 'sh -c \"rm -rf /\"'",
    ]) {
      const result = await expectBehavior(
        command,
        'bypassPermissions',
        {},
        'ask',
      )
      expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
    }
    for (const command of ["sh -c 'rm -rf ./dist'", "bash -c 'echo rm -rf /'"]) {
      await expectBehavior(command, 'bypassPermissions', {}, 'allow')
    }
  })

  test('find prefix allow rules do not cover actions that execute or delete', async () => {
    const rules = { allow: ['Bash(find:*)'] }
    for (const command of [
      'find . -exec touch z \\;',
      'find . -execdir touch z \\;',
      'find . -ok rm {} \\;',
      'find . -delete',
      'find . -name "*.tmp" -delete',
    ]) {
      await expectBehavior(command, 'default', rules, 'ask')
    }
    await expectBehavior('find . -name "*.ts"', 'default', rules, 'allow')
    await expectBehavior(
      'find . -delete',
      'default',
      { allow: ['Bash(find . -delete)'] },
      'allow',
    )
  })

  test('tee targets are checked as file writes', async () => {
    const allow = ['Bash(tee:*)', 'Bash(echo:*)']
    await expectBehavior('echo x | tee /etc/evil', 'default', { allow }, 'ask')
    await expectBehavior('echo x | tee -a /etc/evil', 'default', { allow }, 'ask')
    await expectBehavior(
      'echo x | tee src/x.ts',
      'acceptEdits',
      { allow, deny: ['Edit(./src/x.ts)'] },
      'deny',
    )
    await expectBehavior(
      'echo x | tee -a src/x.ts',
      'acceptEdits',
      { allow, deny: ['Edit(./src/x.ts)'] },
      'deny',
    )
    await expectBehavior('echo x | tee out.txt', 'acceptEdits', { allow }, 'allow')
    await expectBehavior('echo x | tee /dev/null', 'default', { allow }, 'allow')
  })

  test('Read deny rules cover tac, egrep, fgrep, input redirects and option values', async () => {
    const rules = { deny: ['Read(./.env)'] }
    for (const command of [
      'tac .env',
      'egrep X .env',
      'fgrep X .env',
      'cat < .env',
      'git blame --ignore-revs-file=.env src/x.ts',
    ]) {
      await expectBehavior(command, 'default', rules, 'deny')
    }
    await expectBehavior('tac src/x.ts', 'default', rules, 'allow')
    await expectBehavior('git log --format=%H -1', 'default', rules, 'allow')
  })

  test('over-long commands and dangling operators always ask', async () => {
    const allow = { allow: ['Bash(echo:*)', 'Bash(ls:*)'] }
    await expectBehavior('echo ' + 'a'.repeat(10001), 'default', allow, 'ask')
    await expectBehavior('echo ' + 'a'.repeat(9000), 'default', allow, 'allow')
    for (const command of ['ls &&', 'ls ||', 'ls |', 'ls && ']) {
      await expectBehavior(command, 'default', allow, 'ask')
    }
    await expectBehavior(
      'rm -rf build &&',
      'default',
      { deny: ['Bash(rm:*)'] },
      'deny',
    )
  })

  async function expectAskMessage(command: string, rules: Rules) {
    const result = await expectBehavior(command, 'default', rules, 'ask')
    return result.behavior === 'ask' ? result.message : ''
  }

  test('Bash allow rules cover in-project writes but not other path asks', async () => {
    const allow = ['Bash(touch:*)']
    await expectBehavior('touch tl-x', 'default', { allow }, 'allow')
    await expectBehavior('touch tl-x', 'default', { allow: ['Bash(touch tl-x)'] }, 'allow')
    await expectBehavior(
      'echo x | touch tl-x',
      'default',
      { allow: [...allow, 'Bash(echo:*)'] },
      'allow',
    )

    const inside = await expectAskMessage('touch tl-x', {})
    expect(inside).toContain(
      "touch in '" + join(project, 'tl-x') + "' needs approval. The path is inside the working directories for this session (",
    )
    expect(inside).toContain(
      'and Claude Code asks before a shell command creates, changes or removes files there.',
    )

    const outside = await expectAskMessage('touch /opt/cc-path-ask-x', { allow })
    expect(outside).toContain(
      "touch in '/opt/cc-path-ask-x' needs approval. The path is outside the working directories for this session (",
    )
    expect(outside).toContain('Allowing runs the command as written.')
    expect(
      await expectAskMessage('touch tl-x /opt/cc-path-ask-x', { allow }),
    ).toContain("'/opt/cc-path-ask-x' needs approval")

    const safety = await expectBehavior(
      'touch .claude/settings.json',
      'default',
      { allow },
      'ask',
    )
    expect(safety.decisionReason?.type).toBe('safetyCheck')
    await expectBehavior('cd src && touch y', 'default', { allow }, 'ask')
    await expectBehavior('cp -f src/x.ts y', 'default', { allow: ['Bash(cp:*)'] }, 'ask')
    await expectBehavior(
      'touch tl-x',
      'default',
      { allow, deny: ['Edit(./tl-x)'] },
      'deny',
    )

    expect(
      await expectAskMessage('echo x > out.txt', { allow: ['Bash(echo:*)'] }),
    ).toContain(
      "Output redirection to '" + join(project, 'out.txt') + "' needs approval. The path is inside the working directories",
    )
  })

  test('cleanup', () => {
    process.chdir(tmpdir())
    rmSync(project, { recursive: true, force: true })
  })
}
