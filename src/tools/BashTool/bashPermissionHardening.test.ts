import { expect, spyOn, test } from 'bun:test'
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
              CLAUDE_CODE_BASH_HARDENING_PARSER: parserFeature ?? 'legacy',
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

  test('Bash deny rules reach nested and path-qualified commands in default and bypass modes', async () => {
    const rules = { deny: ['Bash(rm:*)'] }
    for (const mode of ['default', 'bypassPermissions'] as const) {
      for (const command of [
        '/bin/rm src/x.ts',
        '/usr/bin/rm src/x.ts',
        'sudo /bin/rm src/x.ts',
        'echo $(rm src/x.ts)',
        'echo `rm src/x.ts`',
        '(rm src/x.ts)',
        '{ rm src/x.ts; }',
        'cat <(rm src/x.ts)',
        'echo hi > >(rm src/x.ts)',
        'for f in src/x.ts; do rm $f; done',
        'x=$(echo hi; rm src/x.ts)',
      ]) {
        await expectBehavior(command, mode, rules, 'deny')
      }
    }
    for (const command of ['echo $(echo rm)', 'echo "rm src/x.ts"', '/bin/echo rm']) {
      const result = await decide(command, 'bypassPermissions', rules)
      expect({ command, behavior: result.behavior }).toEqual({
        command,
        behavior: 'allow',
      })
    }
  })

  test('Bash ask rules reach nested and path-qualified commands in bypass mode', async () => {
    const rules = { ask: ['Bash(rm:*)'] }
    for (const command of [
      '/bin/rm src/x.ts',
      'echo $(rm src/x.ts)',
      '(rm src/x.ts)',
      'cat <(rm src/x.ts)',
      'rm src/x.ts',
    ]) {
      const result = await expectBehavior(command, 'bypassPermissions', rules, 'ask')
      expect(result.decisionReason?.type).toBe('rule')
    }
    await expectBehavior('echo rm', 'bypassPermissions', rules, 'allow')
    await expectBehavior('echo $(rm src/x.ts)', 'default', { ...rules, deny: ['Bash(echo:*)'] }, 'deny')
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

  test('a deny rule on a removal inside a shell -c script asks in every mode', async () => {
    const rules = { deny: ['Bash(rm:*)'] }
    for (const mode of ['default', 'bypassPermissions'] as const) {
      for (const command of [
        "sh -c 'rm -rf build'",
        "bash -c 'echo hi; rm -rf build'",
        "sh -c 'sh -c \"rm -rf build\"'",
      ]) {
        const result = await expectBehavior(command, mode, rules, 'ask')
        expect(requiresExplicitUserApproval(result.decisionReason)).toBe(true)
      }
    }
    await expectBehavior("sh -c 'rm -rf build'", 'bypassPermissions', {}, 'allow')
    await expectBehavior("sh -c 'echo rm'", 'bypassPermissions', rules, 'allow')
  })

  test('Read deny rules see through env and command and cover rev', async () => {
    const rules = { deny: ['Read(./.env)'] }
    for (const mode of ['default', 'bypassPermissions'] as const) {
      for (const command of [
        'env cat .env',
        'env FOO=1 cat .env',
        'command cat .env',
        'rev .env',
        'fold .env',
        'comm .env src/x.ts',
      ]) {
        await expectBehavior(command, mode, rules, 'deny')
      }
    }
    await expectBehavior(
      'env sed -i s/a/b/ src/x.ts',
      'bypassPermissions',
      { deny: ['Edit(./src/x.ts)'] },
      'deny',
    )
    await expectBehavior('rev src/x.ts', 'default', rules, 'allow')
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

  test('Bash allow rules see through command/builtin, test brackets and cd .', async () => {
    const allow = ['Bash(touch:*)']
    for (const command of [
      'command touch tl-x',
      'builtin command touch tl-x',
      'command -p touch tl-x',
      'cd . && touch tl-x',
      '[ -n x ]',
      // The legacy splitter asks for any && after a bracket test.
      ...(process.env.CLAUDE_CODE_BASH_HARDENING_PARSER === 'TREE_SITTER_BASH'
        ? [
            '[ -n x ] && touch tl-x',
            '[[ -n x ]] && touch tl-x',
            '[[ -f x ]] || touch tl-x',
            'if [ -n x ]; then touch tl-x; fi',
          ]
        : []),
    ]) {
      await expectBehavior(command, 'default', { allow }, 'allow')
    }
    for (const command of [
      'command -v ls && touch tl-x',
      'cd src && touch tl-x',
      'cd .. && touch tl-x',
      '[ -f *.ts ] && touch tl-x',
      'command touch /opt/cc-path-ask-x',
    ]) {
      await expectBehavior(command, 'default', { allow }, 'ask')
    }
    await expectBehavior(
      'command rm -rf src',
      'default',
      { allow, deny: ['Bash(rm:*)'] },
      'deny',
    )
  })

  test('auto-allow decisions match official for globs, $HOME, printf, & and runtime paths', async () => {
    const treeSitter =
      process.env.CLAUDE_CODE_BASH_HARDENING_PARSER === 'TREE_SITTER_BASH'
    for (const command of [
      'ls *',
      'cat *.ts',
      'grep x *',
      'grep -rn x --include=*.ts .',
      'head -1 ?',
      'echo $HOME',
      'echo $HOME/x',
      'printf hi',
      'printf -- x',
    ]) {
      await expectBehavior(command, 'default', {}, 'allow')
    }
    for (const command of [
      'sort *',
      'find *',
      'ls src/../*',
      'echo $PATH',
      'printf -v v hi',
      'getconf PATH',
    ]) {
      await expectBehavior(command, 'default', {}, 'ask')
    }

    const allow = ['Bash(touch:*)', 'Bash(ls:*)']
    await expectBehavior('ls && pwd', 'default', { allow }, 'allow')
    if (treeSitter) {
      for (const command of ['ls & pwd', 'touch tl-x &', 'touch "$PWD/tl-x"']) {
        await expectBehavior(command, 'default', { allow }, 'ask')
        await expectBehavior(command, 'bypassPermissions', {}, 'allow')
      }
    }

    for (const command of [
      'touch tl-x',
      'touch tl-x tl-y',
      'touch tl\\-x',
      'sed -n 1p src/x.ts',
    ]) {
      await expectBehavior(command, 'acceptEdits', {}, 'allow')
    }
    for (const command of [
      'touch -d now tl-x',
      'touch -- tl-x',
      'TZ=UTC touch tl-x',
      // The legacy splitter unescapes the command name before this check.
      ...(treeSitter ? ['\\touch tl-x'] : []),
    ]) {
      await expectBehavior(command, 'acceptEdits', {}, 'ask')
    }
  })

  test('a compound command with several output redirects asks in default mode', async () => {
    for (const command of [
      'echo ok > notes.txt && echo ok > /opt/sbdemo/outside.txt',
      'echo ok > notes.txt; echo ok > /etc/cc-hardening-x',
      'echo a > a.txt && echo b > b.txt',
    ]) {
      await expectBehavior(command, 'default', {}, 'ask')
      await expectBehavior(command, 'default', { allow: ['Bash(echo:*)'] }, 'ask')
    }
    const outside = await decide(
      'echo ok > notes.txt && echo ok > /opt/sbdemo/outside.txt',
      'default',
    )
    expect(outside.behavior === 'ask' && outside.blockedPath).toBe(
      '/opt/sbdemo/outside.txt',
    )
    await expectBehavior(
      'echo a > a.txt && echo b > secret.txt',
      'default',
      { deny: ['Edit(./secret.txt)'] },
      'deny',
    )
  })

  test('commands that read a variable they set are never auto-allowed', async () => {
    const allow = ['Bash(echo:*)', 'Bash(git status:*)']
    for (const command of [
      'x=hi; echo "$x"',
      'x=echo; $x f',
      'x=echo; for i in 1 2; do $x f; x=touch; done',
      'x=echo; for i in 1 2; do "$x" f; x=touch; done',
      'x=echo; if true; then x=touch; fi; "$x" f',
      'x=echo; false || x=touch; "$x" f',
      'x=echo; printf -v x touch; "$x" f',
      'for i in a b; do echo "item $i"; done',
    ]) {
      const result = await decide(command, 'default', { allow })
      expect({ command, behavior: result.behavior }).not.toEqual({
        command,
        behavior: 'allow',
      })
    }
    await expectBehavior('echo "$x"', 'default', { allow: ['Bash(echo "$x")'] }, 'allow')
    await expectBehavior('builtin echo hi', 'default', { allow }, 'allow')
    for (const command of ['cat "$HOME/x"', 'wc -l "$HOME/x"', 'ls "$HOME/"']) {
      await expectBehavior(command, 'default', { allow }, 'ask')
    }
    await expectBehavior('builtin eval "echo hi"', 'default', { allow }, 'ask')
  })

  test('dangerouslyDisableSandbox asks unless an allow rule covers the command', async () => {
    const { SandboxManager } =
      await import('../../utils/sandbox/sandbox-adapter.js')
    const enabled = spyOn(SandboxManager, 'isSandboxingEnabled')
    const unsandboxedAllowed = spyOn(
      SandboxManager,
      'areUnsandboxedCommandsAllowed',
    )
    const run = (
      command: string,
      mode: ToolPermissionContext['mode'],
      rules: Rules = {},
    ) =>
      hasPermissionsToUseTool(
        BashTool,
        { command, dangerouslyDisableSandbox: true },
        context(mode, rules),
        undefined as never,
        'bash-hardening',
      )
    try {
      enabled.mockReturnValue(true)
      unsandboxedAllowed.mockReturnValue(true)
      for (const [command, mode, rules, behavior] of [
        ['echo outside', 'default', {}, 'ask'],
        ['cat .env', 'default', {}, 'ask'],
        ['echo a && ls src', 'default', {}, 'ask'],
        ['echo outside', 'acceptEdits', {}, 'ask'],
        ['echo outside', 'default', { allow: ['Bash(echo:*)'] }, 'allow'],
        ['echo a && ls src', 'default', { allow: ['Bash(echo:*)', 'Bash(ls:*)'] }, 'allow'],
        ['echo outside', 'bypassPermissions', {}, 'allow'],
      ] as const) {
        const result = await run(command, mode, rules as Rules)
        expect({ command, mode, behavior: result.behavior }).toEqual({
          command,
          mode,
          behavior,
        })
      }
      // The flag has no effect when the command runs sandboxed anyway.
      unsandboxedAllowed.mockReturnValue(false)
      expect((await run('echo outside', 'default')).behavior).toBe('allow')
      enabled.mockReturnValue(false)
      unsandboxedAllowed.mockReturnValue(true)
      expect((await run('echo outside', 'default')).behavior).toBe('allow')
    } finally {
      enabled.mockRestore()
      unsandboxedAllowed.mockRestore()
    }
  })

  test('sandbox auto-allow runs environment variables and substitutions but not loop or function code', async () => {
    const { SandboxManager } =
      await import('../../utils/sandbox/sandbox-adapter.js')
    const mocks = [
      spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true),
      spyOn(SandboxManager, 'isAutoAllowBashIfSandboxedEnabled').mockReturnValue(true),
    ]
    try {
      for (const command of [
        'echo $HOME',
        'echo "DEMO_TOKEN=[$DEMO_TOKEN]"',
        'echo ${DEMO_TOKEN}',
        'cat <<EOF\nx\nEOF',
        'echo {a,b}',
        'echo $(id -u)',
        'echo `id -u`',
        'echo <(true)',
        "echo $'a\\tb'",
      ]) {
        await expectBehavior(command, 'default', {}, 'allow')
      }
      // Without the syntax tree every sandboxed command runs; these need it.
      const asks =
        process.env.CLAUDE_CODE_BASH_HARDENING_PARSER === 'TREE_SITTER_BASH'
          ? [
              'for f in a b; do echo $f; done',
              'X=$(id -u); echo $X',
              'f() { echo a; }; f',
              'case a in a) echo a;; esac',
              'eval echo hi',
              '$CMD x',
              'cat <<EOF\n$(id -u)\nEOF',
            ]
          : []
      for (const command of asks) {
        await expectBehavior(command, 'default', {}, 'ask')
      }
      await expectBehavior('echo $(rm -rf x)', 'default', { deny: ['Bash(rm:*)'] }, 'deny')
    } finally {
      mocks.forEach(mock => mock.mockRestore())
    }
  })

  test('cleanup', () => {
    process.chdir(tmpdir())
    rmSync(project, { recursive: true, force: true })
  })
}
