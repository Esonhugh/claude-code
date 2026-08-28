import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { parseRootSSHArgv } from './rootSSHArgv.js'

const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
const replSource = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')
const printSource = readFileSync(new URL('../cli/print.ts', import.meta.url), 'utf8')
const setupSource = readFileSync(new URL('../setup.ts', import.meta.url), 'utf8')
const initSource = readFileSync(
  new URL('../entrypoints/init.ts', import.meta.url),
  'utf8',
)
const sessionStartSource = readFileSync(
  new URL('../utils/sessionStart.ts', import.meta.url),
  'utf8',
)
const hooksSource = readFileSync(new URL('../utils/hooks.ts', import.meta.url), 'utf8')
const typeaheadSource = readFileSync(
  new URL('../hooks/useTypeahead.tsx', import.meta.url),
  'utf8',
)
const commandsSource = readFileSync(new URL('../commands.ts', import.meta.url), 'utf8')
const interactiveHelpersSource = readFileSync(
  new URL('../interactiveHelpers.tsx', import.meta.url),
  'utf8',
)
const processBashSource = readFileSync(
  new URL('../utils/processUserInput/processBashCommand.tsx', import.meta.url),
  'utf8',
)
const processUserInputSource = readFileSync(
  new URL('../utils/processUserInput/processUserInput.ts', import.meta.url),
  'utf8',
)
const handlePromptSubmitSource = readFileSync(
  new URL('../utils/handlePromptSubmit.ts', import.meta.url),
  'utf8',
)
const mergedToolsSource = readFileSync(
  new URL('../hooks/useMergedTools.ts', import.meta.url),
  'utf8',
)

test('awaits local SSH session creation before reading the session', () => {
  assert.match(
    source,
    /sshSession = await createLocalSSHSession\(\{/,
  )
})

test('forwards the resolved local model to the remote SSH child', () => {
  assert.match(
    source,
    /!options\.model && _pendingSSH\.extraCliArgs\.includes\('--agent'\)[\s\S]{0,100}\? undefined[\s\S]{0,100}: resolvedInitialModel/,
  )
})

test('does not start local project processes for remote SSH sessions', () => {
  assert.match(
    source,
    /isNonInteractiveSession \|\| isSSHRemoteSession[\s\S]{0,160}Promise\.resolve\(\{ clients: \[\], tools: \[\], commands: \[\] \}\)/,
  )
  assert.match(
    source,
    /logContextMetrics\(\s+isSSHRemoteSession \? \{\} : regularMcpConfigs/,
  )
  assert.match(source, /isSSHLocalUI\(\)[\s\S]{0,100}skipping local LSP/)
  assert.match(
    source,
    /const skipStartupPrefetches =\s+isBareMode\(\) \|\|\s+isSSHLocalUI\(\)/,
  )
  assert.match(
    typeaheadSource,
    /enableLocalIOCompletions &&[\s\S]{0,100}\("production" as string\) !== 'test' &&[\s\S]{0,80}!isSSHLocalUI\(\)/,
  )
  assert.match(
    setupSource,
    /if \(!isBareMode\(\) && !isSSHLocalUI\(\)\) \{[\s\S]{0,1600}registerSessionFileAccessHooks/,
  )
  assert.match(
    source,
    /isNonInteractiveSession \|\|\s+isSSHRemoteSession \|\|\s+options\.continue/,
  )
  assert.match(
    source,
    /if \(isBareMode\(\) \|\| isSSHRemoteSession\)/,
  )
  assert.match(
    replSource,
    /<MCPConnectionManager[\s\S]{0,180}disabled=\{sshRemote\.isRemoteMode\}/,
  )
  assert.match(
    sessionStartSource,
    /isBareMode\(\) \|\| isSSHLocalUI\(\)/,
  )
  assert.match(
    hooksSource,
    /executeSessionEndHooks[\s\S]{0,360}if \(isSSHLocalUI\(\)\) \{\s+return/,
  )
  assert.match(source, /let tools = isSSHRemoteSession \? \[\] : getTools/)
  assert.match(
    source,
    /if \(!isSSHRemoteSession\) \{\s+void logStartupTelemetry\(\)\s+logSessionTelemetry\(\)/,
  )
  assert.match(
    initSource,
    /if \(!isSSHLocalUI\(\)\) void detectCurrentRepository\(\)/,
  )
})

test('uses a fixed local SSH UI command and agent set', () => {
  assert.match(
    source,
    /const \[commands, agentDefinitionsResult\] = isSSHRemoteSession[\s\S]{0,220}getSSHLocalCommands\(\)[\s\S]{0,100}activeAgents: \[\], allAgents: \[\]/,
  )
  assert.match(
    source,
    /worktreeEnabled \|\| isSSHRemoteSession \? null : getCommands\(preSetupCwd\)/,
  )
  assert.match(
    source,
    /worktreeEnabled \|\| isSSHRemoteSession[\s\S]{0,100}getAgentDefinitionsWithOverrides\(preSetupCwd\)/,
  )
  assert.match(
    source,
    /CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&\s+!isSSHRemoteSession/,
  )
  assert.match(
    commandsSource,
    /export function getSSHLocalCommands\(\)[\s\S]{0,180}REMOTE_SAFE_COMMAND_LIST, yolo/,
  )
})

test('disables local project UI facilities for every remote execution transport', () => {
  assert.match(
    replSource,
    /const isRemoteExecutionSession = Boolean\(\s+remoteSessionConfig \|\| directConnectConfig \|\| sshSession/,
  )
  assert.match(
    replSource,
    /useSkillsChange\(\s+isRemoteExecutionSession \? undefined : getProjectRoot\(\)/,
  )
  assert.match(
    replSource,
    /useManagePlugins\(\{ enabled: !isRemoteExecutionSession \}\)/,
  )
  assert.match(
    replSource,
    /useIDEIntegration\(\{\s+enabled: !isRemoteExecutionSession/,
  )
  assert.match(
    replSource,
    /useMailboxBridge\(\{\s+enabled: !isRemoteExecutionSession/,
  )
  assert.match(
    replSource,
    /useScheduledTasks!\(\{\s+enabled: !isRemoteExecutionSession/,
  )
  assert.match(
    replSource,
    /enableLocalIOCompletions=\{!isRemoteExecutionSession\}/,
  )
  assert.match(
    replSource,
    /isRemoteExecutionSession \? \[\] : getTools\(toolPermissionContext\)/,
  )
  assert.match(
    replSource,
    /useMergedTools\([\s\S]{0,180}isRemoteExecutionSession,\s+\)/,
  )
  assert.match(
    mergedToolsSource,
    /if \(disabled\) return initialTools[\s\S]{0,160}assembleToolPool/,
  )
  assert.match(
    replSource,
    /isRemoteExecutionSession \? \[\] : \(plugins\.commands as Command\[\]\)/,
  )
  const sshSessionCall = replSource.match(
    /useSSHSession\(\{[\s\S]*?\n  \}\)/,
  )?.[0]
  assert.ok(sshSessionCall)
  assert.match(sshSessionCall, /tools: \[\],/)
  assert.match(sshSessionCall, /setResponseLength,/)
  assert.match(sshSessionCall, /onStreamingText,/)
  assert.match(
    replSource,
    /const computeTools = \(\) => \{\s+if \(isRemoteExecutionSession\) return \[\]/,
  )
  assert.match(
    replSource,
    /if \(!isRemoteExecutionSession\) \{\s+\/\/ Populate readFileState with CLAUDE\.md files at startup/,
  )
  assert.match(
    replSource,
    /if \(submitCount === 1 && !isRemoteExecutionSession\) \{\s+startBackgroundHousekeeping\(\)/,
  )
  assert.match(
    replSource,
    /if \(isRemoteExecutionSession \|\| tipPickedThisTurnRef\.current\) return/,
  )
})

test('keeps SSH account setup but skips local workspace setup', () => {
  assert.match(
    source,
    /showSetupScreens\([\s\S]{0,260}skipWorkspaceSetup: isSSHRemoteSession/,
  )
  assert.match(
    interactiveHelpersSource,
    /const skipWorkspaceSetup = options\?\.skipWorkspaceSetup === true/,
  )
  assert.match(
    interactiveHelpersSource,
    /if \(!skipWorkspaceSetup && !isEnvTruthy\(process\.env\.CLAUBBIT\)\)/,
  )
  assert.match(
    setupSource,
    /!isSSHLocalUI\(\) &&\s+\(!isBareMode\(\) \|\| messagingSocketPath !== undefined\)/,
  )
})

test('accepts root flags before ssh without treating flag values as the subcommand', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      '--debug-file',
      'ssh',
      '--model',
      'gateway-model',
      'ssh',
      'prod',
      '/srv/project',
      '--permission-mode=acceptEdits',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'prod',
        cwd: '/srv/project',
        permissionMode: 'acceptEdits',
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [],
      },
      remainingArgs: ['--debug-file', 'ssh', '--model', 'gateway-model'],
    },
  )
})

test('uses the last repeated SSH flag value and removes every form', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      '--local=false',
      '--local',
      '--allow-dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions=false',
      '--permission-mode=plan',
      'host.example',
      '--permission-mode',
      'acceptEdits',
      '--model=sonnet',
      '--model',
      'opus',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: 'acceptEdits',
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: true,
        extraCliArgs: [],
      },
      remainingArgs: ['--model=sonnet', '--model', 'opus'],
    },
  )
})

test('extracts SSH-specific flags on either side of the host', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      '--local',
      '--permission-mode',
      'auto',
      '--dangerously-skip-permissions',
      'host.example',
      '/work',
      '--resume',
      'session-id',
      '--model=opus',
      '-c',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: '/work',
        permissionMode: 'auto',
        dangerouslySkipPermissions: true,
        allowDangerouslySkipPermissions: false,
        local: true,
        extraCliArgs: ['--resume', 'session-id', '--continue'],
      },
      remainingArgs: ['--model=opus'],
    },
  )
})

test('keeps local settings flags out of the remote SSH child', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      '--debug',
      '--allowed-tools',
      'Read',
      'Bash(git:*)',
      '--disallowedTools',
      'Bash(rm:*)',
      'ssh',
      'host.example',
      '--tools',
      '',
      '--mcp-config',
      '{"mcpServers":{}}',
      'remote.json',
      '--strict-mcp-config',
      '--add-dir',
      '/remote/a',
      '/remote/b',
      '--settings',
      '/local/settings.json',
      '--setting-sources=user,project',
      '--bare',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [
          '--allowed-tools',
          'Read',
          'Bash(git:*)',
          '--disallowed-tools',
          'Bash(rm:*)',
          '--tools',
          '',
          '--mcp-config',
          '{"mcpServers":{}}',
          'remote.json',
          '--strict-mcp-config',
          '--add-dir',
          '/remote/a',
          '/remote/b',
          '--bare',
        ],
      },
      remainingArgs: [
        '--debug',
        '--settings',
        '/local/settings.json',
        '--setting-sources=user,project',
        '--bare',
      ],
    },
  )
})

test('keeps settings local across SSH flag positions and value forms', () => {
  const inlineSettings =
    '{"model":"local-model","env":{"SSH_CANARY":"local-only"}}'
  const cases = [
    {
      args: ['--settings=/local/settings.json', 'ssh', 'host.example'],
      localArgs: ['--settings=/local/settings.json'],
    },
    {
      args: ['ssh', '--settings', inlineSettings, 'host.example'],
      localArgs: ['--settings', inlineSettings],
    },
    {
      args: [
        'ssh',
        'host.example',
        '--setting-sources',
        'user,project,local',
      ],
      localArgs: ['--setting-sources', 'user,project,local'],
    },
  ]

  for (const { args, localArgs } of cases) {
    const parsed = parseRootSSHArgv(args)
    assert.equal(parsed.type, 'ssh')
    if (parsed.type !== 'ssh') continue
    assert.deepEqual(parsed.pending.extraCliArgs, [])
    assert.deepEqual(parsed.remainingArgs, localArgs)
  }
})

test('finds ssh after variadic root flags and does not consume it as an optional value', () => {
  const variadicCases = [
    ['--tools', 'Read', 'Bash'],
    ['--disallowed-tools', 'Bash', 'Write'],
    ['--mcp-config', 'a.json', 'b.json'],
    ['--add-dir', '/a', '/b'],
    ['--betas', 'beta1', 'beta2'],
    ['--file', 'f1:path', 'f2:path'],
    ['--channels', 'server1', 'server2'],
  ]
  for (const prefix of variadicCases) {
    assert.equal(
      parseRootSSHArgv([...prefix, 'ssh', 'host.example']).type,
      'ssh',
    )
  }
  assert.equal(
    parseRootSSHArgv(['--debug', 'ssh', 'host.example']).type,
    'ssh',
  )
  assert.equal(
    parseRootSSHArgv(['--remote-control', 'ssh', 'host.example']).type,
    'ssh',
  )
  assert.equal(
    parseRootSSHArgv(['--teleport', 'ssh', 'host.example']).type,
    'ssh',
  )
})

test('rejects local worktree and tmux execution for SSH sessions', () => {
  for (const args of [
    ['--worktree', 'ssh', 'host.example'],
    ['-w=feature', 'ssh', 'host.example'],
    ['-wfeature', 'ssh', 'host.example'],
    ['ssh', 'host.example', '--worktree'],
    ['ssh', 'host.example', '--worktree=feature'],
    ['ssh', 'host.example', '-wfeature'],
  ]) {
    assert.deepEqual(parseRootSSHArgv(args), {
      type: 'error',
      message: 'Error: --worktree is not supported with claude ssh\n',
    })
  }

  for (const args of [
    ['--tmux', 'ssh', 'host.example'],
    ['ssh', 'host.example', '--tmux'],
    ['ssh', 'host.example', '--tmux=classic'],
  ]) {
    assert.deepEqual(parseRootSSHArgv(args), {
      type: 'error',
      message: 'Error: --tmux is not supported with claude ssh\n',
    })
  }
})

test('forwards agent teams to the remote child', () => {
  assert.deepEqual(
    parseRootSSHArgv(['ssh', 'host.example', '--agent-teams']),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: ['--agent-teams'],
      },
      remainingArgs: [],
    },
  )
})

test('forwards short resume and rejects equals-form headless mode', () => {
  for (const resumeArgs of [
    ['-r', 'session-id'],
    ['-rsession-id'],
    ['-r=session-id'],
  ]) {
    assert.deepEqual(parseRootSSHArgv(['ssh', 'host.example', ...resumeArgs]), {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: ['--resume', 'session-id'],
      },
      remainingArgs: [],
    })
  }
  assert.deepEqual(parseRootSSHArgv(['ssh', 'host.example', '--print=true']), {
    type: 'error',
    message:
      'Error: headless (-p/--print) mode is not supported with claude ssh\n',
  })
})

test('forwards remote required values and advisor ownership', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      'host.example',
      '--agent',
      '-reviewer',
      '--settings',
      '-remote.json',
      '--advisor',
      'opus',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [
          '--agent',
          '-reviewer',
          '--advisor',
          'opus',
        ],
      },
      remainingArgs: ['--settings', '-remote.json'],
    },
  )
})

test('does not mistake required values for unsupported workspace options', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      '--agent',
      '--worktree',
      'ssh',
      'host.example',
      '--settings',
      '--tmux',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [
          '--agent',
          '--worktree',
        ],
      },
      remainingArgs: ['--settings', '--tmux'],
    },
  )
})

test('supports a dash-prefixed remote cwd after the option separator', () => {
  assert.deepEqual(parseRootSSHArgv(['ssh', 'host.example', '--', '-cwd']), {
    type: 'ssh',
    pending: {
      host: 'host.example',
      cwd: '-cwd',
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      allowDangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
    },
    remainingArgs: [],
  })
})

test('rejects local SDK transport for SSH sessions', () => {
  for (const args of [
    ['ssh', 'host.example', '--sdk-url', 'ws://example'],
    ['ssh', 'host.example', '--sdk-url=ws://example'],
  ]) {
    assert.deepEqual(parseRootSSHArgv(args), {
      type: 'error',
      message: 'Error: --sdk-url is not supported with claude ssh\n',
    })
  }
})

test('normalizes auto permission aliases for the remote child', () => {
  for (const alias of [
    '--delegate-permissions',
    '--dangerously-skip-permissions-with-classifiers',
    '--afk',
  ]) {
    assert.deepEqual(parseRootSSHArgv(['ssh', 'host.example', alias]), {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: 'auto',
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [],
      },
      remainingArgs: [],
    })
  }
})

test('keeps model local so only the resolved value reaches the remote child', () => {
  assert.deepEqual(parseRootSSHArgv(['ssh', 'host.example', '--model', 'opus']), {
    type: 'ssh',
    pending: {
      host: 'host.example',
      cwd: undefined,
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      allowDangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
    },
    remainingArgs: ['--model', 'opus'],
  })
})

test('preserves opt-in permission switching on both SSH processes', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      'host.example',
      '--allow-dangerously-skip-permissions',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: true,
        local: false,
        extraCliArgs: [],
      },
      remainingArgs: [],
    },
  )
  assert.match(
    source,
    /pending\.allowDangerouslySkipPermissions[\s\S]{0,100}--allow-dangerously-skip-permissions/,
  )
})

test('does not expose bypass in the local Shift+Tab cycle without opt-in', () => {
  assert.match(
    source,
    /permissionMode,\s+allowDangerouslySkipPermissions,\s+addDirs: addDir/,
  )
  assert.doesNotMatch(
    source,
    /allowDangerouslySkipPermissions\s*\|\|\s*\(feature\('SSH_REMOTE'\)/,
  )
})

test('keeps explicit /yolo available independently of the Shift+Tab opt-in', () => {
  assert.match(
    replSource,
    /mode === 'bypassPermissions'[\s\S]{0,160}isBypassPermissionsModeAvailable: true/,
  )
})

test('synchronizes permission mode changes to the SSH child before local commit', () => {
  assert.match(
    replSource,
    /requestPermissionModeChange=\{requestPermissionModeChange\}/,
  )
  assert.match(
    replSource,
    /permissionModeChangeRef\.current\.then\(async \(\) =>/,
  )
  assert.match(
    replSource,
    /generation !== permissionModeChangeGenerationRef\.current/,
  )
  assert.match(replSource, /sshRemote\.getPermissionMode\(\)/)
  assert.match(replSource, /transitionPermissionMode\(current\.mode, mode, current\)/)
  assert.match(
    replSource,
    /Permission mode changes are unavailable in this remote session/,
  )
})

test('routes SSH bash input to the remote shell executor instead of the model', () => {
  assert.match(
    replSource,
    /const setInputMode = useCallback\(\(mode: PromptInputMode\) => \{\s+inputModeRef\.current = mode\s+setInputModeState\(mode\)/,
  )
  assert.match(
    replSource,
    /inputModeRef\.current === 'bash' &&\s+rawInput\.startsWith\('!'\)[\s\S]{0,80}rawInput\.slice\(1\)/,
  )
  assert.match(
    replSource,
    /const submittedInputMode = inputModeRef\.current/,
  )
  assert.match(
    replSource,
    /const isSSHBashCommand =\s+sshRemote\.isRemoteMode && submittedInputMode === 'bash'/,
  )
  assert.match(
    replSource,
    /activeRemote\.isRemoteMode &&\s+!isSSHBashCommand &&/,
  )
  assert.match(
    replSource,
    /runRemoteShellCommand: sshRemote\.isRemoteMode\s+\? sshRemote\.runShellCommand/,
  )
  assert.match(
    replSource,
    /skipLocalContext: isRemoteExecutionSession/,
  )
  assert.match(
    handlePromptSubmitSource,
    /pastedContents:\s+isFirst && !skipLocalContext/,
  )
  assert.match(
    handlePromptSubmitSource,
    /skipAttachments: skipLocalContext \|\| !isFirst,\s+skipHooks: skipLocalContext/,
  )
  assert.match(
    handlePromptSubmitSource,
    /if \(!skipLocalContext && fileHistoryEnabled\(\)\)/,
  )
  assert.match(
    processUserInputSource,
    /if \(!result\.shouldQuery \|\| isRemoteShellInput \|\| skipHooks\)/,
  )
})

test('escapes shell input and preserves partial output on interruption', () => {
  assert.match(
    processBashSource,
    /inputString: `<bash-input>\$\{escapeXml\(inputString\)\}<\/bash-input>`/,
  )
  assert.match(
    processBashSource,
    /data\.stdout \|\| stderr \|\| !data\.interrupted[\s\S]{0,320}data\.interrupted[\s\S]{0,100}createUserInterruptionMessage/,
  )
})

test('requires the managed SSH capability for direct shell control', () => {
  assert.match(
    printSource,
    /process\.env\.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1'/,
  )
  assert.match(printSource, /process\.env\.CLAUDE_CODE_SSH_REMOTE === '1'/)
  assert.match(
    printSource,
    /message\.request\.ssh_remote_token === sshRemoteToken/,
  )
})

test('serializes direct shell commands with model turns and records their history', () => {
  assert.match(printSource, /if \(running \|\| shellCommandRunning\)/)
  assert.match(
    printSource,
    /else if \(running\) \{[\s\S]{0,180}sendControlResponseError\(message, 'A model turn is already running'\)/,
  )
  assert.match(
    printSource,
    /const transcript = createRemoteShellTranscript\([\s\S]{0,240}mutableMessages\.push\(\.\.\.transcript\)/,
  )
  const shellTranscriptPush = printSource.indexOf(
    'mutableMessages.push(...transcript)',
  )
  const shellTranscriptPersist = printSource.indexOf(
    'await recordTranscript(mutableMessages)',
    shellTranscriptPush,
  )
  const shellResponse = printSource.indexOf(
    'sendControlResponseSuccess(request, response)',
    shellTranscriptPersist,
  )
  assert.ok(shellTranscriptPush >= 0)
  assert.ok(shellTranscriptPersist > shellTranscriptPush)
  assert.ok(shellResponse > shellTranscriptPersist)
  assert.match(
    printSource,
    /shellCommandRunning = false[\s\S]{0,700}void run\(\)/,
  )
  assert.match(printSource, /if \(!running && !shellCommandRunning\)/)
  assert.match(
    printSource,
    /else if \(inputClosed\) \{[\s\S]{0,240}output\.done\(\)/,
  )
})

test('rejects headless SSH and ignores non-command ssh arguments', () => {
  assert.deepEqual(parseRootSSHArgv(['--print', 'ssh', 'host.example']), {
    type: 'error',
    message:
      'Error: headless (-p/--print) mode is not supported with claude ssh\n',
  })
  assert.deepEqual(parseRootSSHArgv(['--', 'ssh', 'host.example']), {
    type: 'none',
  })
  assert.deepEqual(parseRootSSHArgv(['explain', 'ssh', 'host.example']), {
    type: 'none',
  })
})

test('stops extracting SSH flags at the option separator', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      'host.example',
      '--',
      '--dangerously-skip-permissions',
      '--permission-mode=plan',
      '--continue',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: '--dangerously-skip-permissions',
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [],
      },
      remainingArgs: ['--', '--permission-mode=plan', '--continue'],
    },
  )
})

test('leaves invalid boolean continue values for Commander to reject', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      'host.example',
      '--continue=false',
      '-c=false',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: [],
      },
      remainingArgs: ['--continue=false', '-c=false'],
    },
  )
})

test('only trusts adjacent development SSH artifacts', () => {
  const sshSource = readFileSync(
    new URL('./createSSHSession.ts', import.meta.url),
    'utf8',
  )
  assert.match(sshSource, /dirname\(process\.execPath\)/)
  assert.doesNotMatch(
    sshSource,
    /join\(\s*process\.cwd\(\),\s*'dist',\s*'release'/,
  )
})

test('creates an abort controller before sending a remote prompt', () => {
  assert.match(
    replSource,
    /const remoteAbortController = createAbortController\(\)\s+setAbortController\(remoteAbortController\)[\s\S]{0,80}await activeRemote\.sendMessage/,
  )
})

test('only keeps remote cancel active while the remote turn is loading', () => {
  assert.match(
    replSource,
    /abortSignal:\s+activeRemote\.isRemoteMode && !isLoading\s+\? undefined\s+: abortController\?\.signal/,
  )
})
