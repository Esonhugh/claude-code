import { feature } from 'bun:bundle'

type ProfileCheckpoint = (name: string) => void

export async function dispatchFastPath(
  args: string[],
  profileCheckpoint: ProfileCheckpoint,
): Promise<boolean> {
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { getMainLoopModel } = await import('../utils/model/model.js')
    const modelIdx = args.indexOf('--model')
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel()
    const { getSystemPrompt } = await import('../constants/prompts.js')
    const prompt = await getSystemPrompt([], model)
    console.log(prompt.join('\n'))
    return true
  }

  if (args[0] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path')
    const { runClaudeInChromeMcpServer } = await import(
      '../utils/claudeInChrome/mcpServer.js'
    )
    await runClaudeInChromeMcpServer()
    return true
  }

  if (args[0] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path')
    const { runChromeNativeHost } = await import(
      '../utils/claudeInChrome/chromeNativeHost.js'
    )
    await runChromeNativeHost()
    return true
  }

  if (feature('CHICAGO_MCP') && args[0] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path')
    const { runComputerUseMcpServer } = await import(
      '../utils/computerUse/mcpServer.js'
    )
    await runComputerUseMcpServer()
    return true
  }

  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js')
    await runDaemonWorker(args[1])
    return true
  }

  if (
    feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' ||
      args[0] === 'rc' ||
      args[0] === 'remote' ||
      args[0] === 'sync' ||
      args[0] === 'bridge')
  ) {
    profileCheckpoint('cli_bridge_path')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()

    const { getBridgeDisabledReason, checkBridgeMinVersion } = await import(
      '../bridge/bridgeEnabled.js'
    )
    const { BRIDGE_LOGIN_ERROR } = await import('../bridge/types.js')
    const { bridgeMain } = await import('../bridge/bridgeMain.js')
    const { exitWithError } = await import('../utils/process.js')
    const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')

    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR)
    }
    const disabledReason = await getBridgeDisabledReason()
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`)
    }
    const versionError = checkBridgeMinVersion()
    if (versionError) {
      exitWithError(versionError)
    }

    const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import(
      '../services/policyLimits/index.js'
    )
    await waitForPolicyLimitsToLoad()
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError(
        "Error: Remote Control is disabled by your organization's policy.",
      )
    }

    await bridgeMain(args.slice(1))
    return true
  }

  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { initSinks } = await import('../utils/sinks.js')
    initSinks()
    const { daemonMain } = await import('../daemon/main.js')
    await daemonMain(args.slice(1))
    return true
  }

  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' ||
      args[0] === 'logs' ||
      args[0] === 'attach' ||
      args[0] === 'kill' ||
      args.includes('--bg') ||
      args.includes('--background'))
  ) {
    profileCheckpoint('cli_bg_path')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const bg = await import('../cli/bg.js')
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1))
        break
      case 'logs':
        await bg.logsHandler(args[1])
        break
      case 'attach':
        await bg.attachHandler(args[1])
        break
      case 'kill':
        await bg.killHandler(args[1])
        break
      default:
        await bg.handleBgFlag(args)
    }
    return true
  }

  if (
    feature('TEMPLATES') &&
    (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')
  ) {
    profileCheckpoint('cli_templates_path')
    const { templatesMain } = await import('../cli/handlers/templateJobs.js')
    await templatesMain(args)
    process.exit(0)
  }

  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path')
    const { environmentRunnerMain } = await import(
      '../environment-runner/main.js'
    )
    await environmentRunnerMain(args.slice(1))
    return true
  }

  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path')
    const { selfHostedRunnerMain } = await import(
      '../self-hosted-runner/main.js'
    )
    await selfHostedRunnerMain(args.slice(1))
    return true
  }

  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic')
  if (
    hasTmuxFlag &&
    (args.includes('-w') ||
      args.includes('--worktree') ||
      args.some(a => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { isWorktreeModeEnabled } = await import(
      '../utils/worktreeModeEnabled.js'
    )
    if (isWorktreeModeEnabled()) {
      const { execIntoTmuxWorktree } = await import('../utils/worktree.js')
      const result = await execIntoTmuxWorktree(args)
      if (result.handled) {
        return true
      }
      if (result.error) {
        const { exitWithError } = await import('../utils/process.js')
        exitWithError(result.error)
      }
    }
  }

  if (
    args.length === 1 &&
    (args[0] === '--update' || args[0] === '--upgrade')
  ) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update']
  }

  return false
}
