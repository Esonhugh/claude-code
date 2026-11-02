/**
 * MCP subcommand handlers — extracted from main.tsx for lazy loading.
 * These are dynamically imported only when the corresponding `claude mcp *` command runs.
 */

import figures from 'figures'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { stat } from 'fs/promises'
import pMap from 'p-map'
import { cwd } from 'process'
import React from 'react'
import { createInterface } from 'readline'
import { MCPServerDesktopImportDialog } from '../../components/MCPServerDesktopImportDialog.js'
import { McpParsingWarnings } from '../../components/mcp/McpParsingWarnings.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  AuthenticationCancelledError,
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
  getMcpClientConfig,
  performMCPOAuthFlow,
  readClientSecret,
  revokeServerTokens,
  saveMcpClientSecret,
} from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  connectToServer,
  getMcpServerConnectionBatchSize,
} from '../../services/mcp/client.js'
import {
  addMcpConfig,
  getAllMcpConfigs,
  getConfiguredMcpConfigByName,
  getMcpConfigByName,
  getMcpConfigsByScope,
  isMcpServerDisabled,
  removeMcpConfig,
} from '../../services/mcp/config.js'
import type {
  ConfigScope,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  getProjectMcpServerStatus,
  getScopeLabel,
} from '../../services/mcp/utils.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
} from '../../utils/config.js'
import { errorMessage, isFsInaccessible } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { safeParseJSON } from '../../utils/json.js'
import { getPlatform } from '../../utils/platform.js'
import { renderToString } from '../../utils/staticRender.js'
import { cliError, cliOk } from '../exit.js'

type HealthStatus = { status: string; issue?: string }

async function checkMcpServerHealth(
  name: string,
  server: ScopedMcpServerConfig,
): Promise<HealthStatus> {
  try {
    const result = await connectToServer(name, server)
    if (result.type === 'connected') {
      return { status: `${figures.tick} Connected` }
    } else if (result.type === 'needs-auth') {
      return { status: '! Needs authentication' }
    } else if (result.type === 'failed' && result.error) {
      return { status: `${figures.cross} Failed to connect`, issue: result.error }
    } else {
      return { status: `${figures.cross} Failed to connect` }
    }
  } catch (_error) {
    return { status: `${figures.cross} Connection error` }
  }
}

// Like official 2.1.311: only names that are safe to paste unquoted get a
// ready-to-run command.
function removeCommandFor(name: string, scope: string): string | null {
  return /^\w[\w.@-]*$/.test(name)
    ? `claude mcp remove ${name} -s ${scope}`
    : null
}

// mcp serve (lines 4512–4532)
export async function mcpServeHandler({
  debug,
  verbose,
}: {
  debug?: boolean
  verbose?: boolean
}): Promise<void> {
  const providedCwd = cwd()
  logEvent('tengu_mcp_start', {})

  try {
    await stat(providedCwd)
  } catch (error) {
    if (isFsInaccessible(error)) {
      cliError(`Error: Directory ${providedCwd} does not exist`)
    }
    throw error
  }

  try {
    const { setup } = await import('../../setup.js')
    await setup(providedCwd, 'default', false, false, undefined, false)
    const { startMCPServer } = await import('../../entrypoints/mcp.js')
    await startMCPServer(providedCwd, debug ?? false, verbose ?? false)
  } catch (error) {
    cliError(`Error: Failed to start MCP server: ${error}`)
  }
}

// mcp remove (lines 4545–4635)
export async function mcpRemoveHandler(
  name: string,
  options: { scope?: string },
): Promise<void> {
  // Look up config before removing so we can clean up secure storage
  const serverBeforeRemoval = getConfiguredMcpConfigByName(name)

  const cleanupSecureStorage = () => {
    if (
      serverBeforeRemoval &&
      (serverBeforeRemoval.type === 'sse' ||
        serverBeforeRemoval.type === 'http')
    ) {
      clearServerTokensFromLocalStorage(name, serverBeforeRemoval)
      clearMcpClientConfig(name, serverBeforeRemoval)
    }
  }

  try {
    if (options.scope) {
      const scope = ensureConfigScope(options.scope)
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope:
          scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      await removeMcpConfig(name, scope)
      cleanupSecureStorage()
      process.stdout.write(`Removed MCP server ${name} from ${scope} config\n`)
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`)
    }

    // If no scope specified, check where the server exists
    const projectConfig = getCurrentProjectConfig()
    const globalConfig = getGlobalConfig()

    // Check if server exists in project scope (.mcp.json)
    const { servers: projectServers } = getMcpConfigsByScope('project')
    const mcpJsonExists = !!projectServers[name]

    // Count how many scopes contain this server
    const scopes: Array<Exclude<ConfigScope, 'dynamic'>> = []
    if (projectConfig.mcpServers?.[name]) scopes.push('local')
    if (mcpJsonExists) scopes.push('project')
    if (globalConfig.mcpServers?.[name]) scopes.push('user')

    if (scopes.length === 0) {
      cliError(
        noServerNamed(name, Object.keys((await getAllMcpConfigs()).servers)),
      )
    } else if (scopes.length === 1) {
      // Server exists in only one scope, remove it
      const scope = scopes[0]!
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope:
          scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      await removeMcpConfig(name, scope)
      cleanupSecureStorage()
      process.stdout.write(
        `Removed MCP server "${name}" from ${scope} config\n`,
      )
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`)
    } else {
      // Server exists in multiple scopes
      process.stderr.write(`MCP server "${name}" exists in multiple scopes:\n`)
      scopes.forEach(scope => {
        process.stderr.write(
          `  - ${getScopeLabel(scope)} (${describeMcpConfigFilePath(scope)})\n`,
        )
      })
      const commands = scopes.flatMap(
        scope => removeCommandFor(name, scope) ?? [],
      )
      if (commands.length > 0) {
        process.stderr.write('\nTo remove from a specific scope, use:\n')
        commands.forEach(command => process.stderr.write(`  ${command}\n`))
      } else {
        process.stderr.write(
          '\nSpecify a scope with -s to remove from a specific one.\n',
        )
      }
      cliError()
    }
  } catch (error) {
    cliError((error as Error).message)
  }
}

const PENDING_APPROVAL_STATUS = '⏸ Pending approval (run `claude` to approve)'
const REJECTED_STATUS = `${figures.cross} Rejected (see disabledMcpjsonServers in settings)`
const DISABLED_STATUS = '⊘ Disabled for this project (re-enable via /mcp)'

// mcp list (lines 4641–4688)
export async function mcpListHandler(): Promise<void> {
  logEvent('tengu_mcp_list', {})
  const { servers: configs } = await getAllMcpConfigs({
    includePendingProjectServers: true,
  })
  if (Object.keys(configs).length === 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      'No MCP servers configured. Use `claude mcp add` to add a server.',
    )
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Checking MCP server health…\n')

    // Check servers concurrently; only connect to servers the session would
    const entries = Object.entries(configs)
    const results = await pMap(
      entries,
      async ([name, server]) => {
        const health: HealthStatus =
          server.scope === 'project' &&
          getProjectMcpServerStatus(name) === 'pending'
            ? { status: PENDING_APPROVAL_STATUS }
            : isMcpServerDisabled(name)
              ? { status: DISABLED_STATUS }
              : await checkMcpServerHealth(name, server)
        return {
          name,
          server,
          status: health.issue
            ? `${health.status} — ${health.issue}`
            : health.status,
        }
      },
      { concurrency: getMcpServerConnectionBatchSize() },
    )

    for (const { name, server, status } of results) {
      // Intentionally excluding sse-ide servers here since they're internal
      if (server.type === 'sse') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (SSE) - ${status}`)
      } else if (server.type === 'http') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (HTTP) - ${status}`)
      } else if (server.type === 'claudeai-proxy') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} - ${status}`)
      } else if ('command' in server) {
        const args = Array.isArray(server.args) ? server.args : []
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.command} ${args.join(' ')} - ${status}`)
      }
    }
  }
  const diagnostics = (
    await renderToString(<McpParsingWarnings />, process.stdout.columns)
  ).trim()
  if (diagnostics) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`\n${diagnostics}`)
  }
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0)
}

function noServerNamed(name: string, configured: string[]): string {
  if (configured.length === 0) {
    return `No MCP server named "${name}". Run \`claude mcp add\` to add one.`
  }
  const names = [...configured].sort()
  const more =
    names.length > 8
      ? ` (and ${names.length - 8} more — run \`claude mcp list\` to see all)`
      : ''
  return `No MCP server named "${name}". Configured servers: ${names.slice(0, 8).join(', ')}${more}`
}

// mcp get (lines 4694–4786)
export async function mcpGetHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_get', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  const server = getMcpConfigByName(name, {
    includeUnapprovedProjectServers: true,
  })
  if (!server) {
    return cliError(
      noServerNamed(name, Object.keys((await getAllMcpConfigs()).servers)),
    )
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`${name}:`)
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Scope: ${getScopeLabel(server.scope)}`)

  // Only health-check (connect to) servers the session would connect to
  const projectStatus =
    server.scope === 'project' ? getProjectMcpServerStatus(name) : 'approved'
  const health: HealthStatus =
    projectStatus === 'pending'
      ? { status: PENDING_APPROVAL_STATUS }
      : projectStatus === 'rejected'
        ? { status: REJECTED_STATUS }
        : isMcpServerDisabled(name)
          ? { status: DISABLED_STATUS }
          : await checkMcpServerHealth(name, server)
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Status: ${health.status}`)
  if (health.issue) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Issue: ${health.issue}`)
  }

  // Intentionally excluding sse-ide servers here since they're internal
  if (server.type === 'sse') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: sse`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`)
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:')
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${value}`)
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = []
      if (server.oauth.clientId) {
        parts.push('client_id configured')
        const clientConfig = getMcpClientConfig(name, server)
        if (clientConfig?.clientSecret) parts.push('client_secret configured')
      }
      if (server.oauth.callbackPort)
        parts.push(`callback_port ${server.oauth.callbackPort}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`)
    }
  } else if (server.type === 'http') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: http`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`)
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:')
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${value}`)
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = []
      if (server.oauth.clientId) {
        parts.push('client_id configured')
        const clientConfig = getMcpClientConfig(name, server)
        if (clientConfig?.clientSecret) parts.push('client_secret configured')
      }
      if (server.oauth.callbackPort)
        parts.push(`callback_port ${server.oauth.callbackPort}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`)
    }
  } else if ('command' in server) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: stdio`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Command: ${server.command}`)
    const args = Array.isArray(server.args) ? server.args : []
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Args: ${args.join(' ')}`)
    if (server.env) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Environment:')
      for (const [key, value] of Object.entries(server.env)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}=${value}`)
      }
    }
  }
  if (server.timeout !== undefined) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `  Timeout: ${server.timeout}ms${server.timeout < 1000 ? ' (ignored: below 1000ms minimum)' : ''}`,
    )
  }
  const editable =
    server.scope === 'local' ||
    server.scope === 'project' ||
    server.scope === 'user'
  const command = editable ? removeCommandFor(name, server.scope) : null
  const removeHint = command
    ? `To remove this server, run: ${command}`
    : editable || server.scope === 'enterprise'
      ? `To remove this server, edit ${describeMcpConfigFilePath(server.scope)}`
      : server.scope === 'managed'
        ? "This server is provided by your organization's managed settings and cannot be removed locally."
        : null
  if (removeHint) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`\n${removeHint}`)
  }
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0)
}

// Looks a server up for `mcp login`/`mcp logout`: configured scopes first,
// then plugin and claude.ai servers. Unapproved .mcp.json servers are refused.
async function getServerForAuth(
  name: string,
): Promise<ScopedMcpServerConfig | undefined> {
  const server =
    getMcpConfigByName(name, { includeUnapprovedProjectServers: true }) ??
    (await getAllMcpConfigs()).servers[name]
  if (!server) {
    return cliError(
      noServerNamed(name, Object.keys((await getAllMcpConfigs()).servers)),
    )
  }
  const projectStatus =
    server.scope === 'project' ? getProjectMcpServerStatus(name) : 'approved'
  if (projectStatus === 'rejected') {
    return cliError(
      `"${name}" is from .mcp.json and was rejected. Run \`claude mcp reset-project-choices\` to review it again.`,
    )
  }
  if (projectStatus === 'pending') {
    return cliError(
      `"${name}" is from .mcp.json and awaiting approval. Run \`claude\` in this directory to review it first.`,
    )
  }
  return server
}

function hasStaticAuthorizationHeader(
  server: McpSSEServerConfig | McpHTTPServerConfig,
): boolean {
  return Object.keys(server.headers ?? {}).some(
    key => key.toLowerCase() === 'authorization',
  )
}

function authorizationUrlMessage(browser: boolean, url: string): string {
  return `${browser ? "If the browser didn't open, visit:" : 'Visit this URL to authorize:'}\n  ${url}\n`
}

// mcp login
export async function mcpLoginHandler(
  name: string,
  options: { browser?: boolean },
): Promise<void> {
  logEvent('tengu_mcp_login', {})
  const server = await getServerForAuth(name)
  if (!server) return
  if (server.type === 'claudeai-proxy') {
    return cliError(
      `"${name}" is a claude.ai connector — authenticate it from /mcp in an interactive session.`,
    )
  }
  if (server.type !== 'http' && server.type !== 'sse') {
    return cliError(
      `"${name}" doesn't support OAuth login — it's only available for HTTP and SSE servers.`,
    )
  }
  if (hasStaticAuthorizationHeader(server)) {
    return cliError(
      `"${name}" authenticates with the \`Authorization\` header in its configuration, so there's no separate login. Update that header to change its credentials.`,
    )
  }

  const browser = options.browser !== false
  process.stdout.write(`Starting authentication for "${name}"…\n`)
  const controller = new AbortController()
  let stdinNotTerminal = false
  let pastePrompt: ReturnType<typeof createInterface> | undefined
  // The OAuth callback server is unref'd; keep the process alive while waiting.
  const keepAlive = setInterval(() => {}, 60_000)
  try {
    await revokeServerTokens(name, server, { preserveStepUpState: true })
    await performMCPOAuthFlow(
      name,
      server,
      url => {
        process.stdout.write(
          `${authorizationUrlMessage(browser, url)}Waiting for authorization… (^C to cancel)\n`,
        )
        pastePrompt?.prompt()
      },
      controller.signal,
      {
        skipBrowserOpen: !browser,
        onWaitingForCallback: submit => {
          if (!process.stdin.isTTY) {
            stdinNotTerminal = true
            controller.abort()
            return
          }
          if (!process.stdout.isTTY) return
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'Or paste the redirect URL here: ',
          })
          prompt.on('SIGINT', () => controller.abort())
          prompt.on('close', () => controller.abort())
          prompt.on('line', line => {
            const callbackUrl = line.trim()
            if (callbackUrl && submit(callbackUrl)) return
            if (callbackUrl) {
              process.stdout.write(
                "That doesn't look like a redirect URL for this sign-in — paste the full address from the browser page this sign-in opened.\n",
              )
            }
            prompt.prompt()
          })
          pastePrompt = prompt
        },
      },
    )
  } catch (error) {
    if (error instanceof AuthenticationCancelledError) {
      if (stdinNotTerminal) {
        return cliError(
          `Couldn't complete authentication for "${name}": stdin isn't a terminal, so authentication can't be completed here. ` +
            'Re-run in an interactive terminal — e.g. `ssh -t` — and paste the redirect URL when prompted.',
        )
      }
      return gracefulShutdown(130)
    }
    return cliError(
      `Couldn't complete authentication for "${name}": ${errorMessage(error)}`,
    )
  } finally {
    clearInterval(keepAlive)
    if (pastePrompt) {
      pastePrompt.removeAllListeners('close')
      pastePrompt.close()
      process.stdout.write('\n')
    }
  }

  // Drop cached needs-auth results so the next session connects right away.
  clearMcpAuthCache()
  cliOk(
    isMcpServerDisabled(name)
      ? `Authenticated with "${name}", but it's currently disabled. Enable it in /mcp for its tools to load.`
      : `Authenticated with "${name}". Its tools are now available in Claude Code.`,
  )
}

// mcp logout
export async function mcpLogoutHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_logout', {})
  const server = await getServerForAuth(name)
  if (!server) return
  if (server.type === 'claudeai-proxy') {
    return cliOk(
      `"${name}" is a claude.ai connector — its credentials live on claude.ai, not this machine. ` +
        `Disconnect it at ${getOauthConfig().CLAUDE_AI_ORIGIN}/customize/connectors`,
    )
  }
  if (server.type !== 'http' && server.type !== 'sse') {
    return cliError(
      `"${name}" doesn't use OAuth — there are no stored credentials to clear.`,
    )
  }
  await revokeServerTokens(name, server)
  const loginHint =
    !hasStaticAuthorizationHeader(server) && /^\w[\w.@-]*$/.test(name)
      ? ` Run \`claude mcp login ${name}\` to authenticate again.`
      : ''
  cliOk(`Signed out of "${name}".${loginHint}`)
}

// mcp add-json (lines 4801–4870)
export async function mcpAddJsonHandler(
  name: string,
  json: string,
  options: { scope?: string; clientSecret?: true },
): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope)
    const parsedJson = safeParseJSON(json)

    // Read secret before writing config so cancellation doesn't leave partial state
    const needsSecret =
      options.clientSecret &&
      parsedJson &&
      typeof parsedJson === 'object' &&
      'type' in parsedJson &&
      (parsedJson.type === 'sse' || parsedJson.type === 'http') &&
      'url' in parsedJson &&
      typeof parsedJson.url === 'string' &&
      'oauth' in parsedJson &&
      parsedJson.oauth &&
      typeof parsedJson.oauth === 'object' &&
      'clientId' in parsedJson.oauth
    const clientSecret = needsSecret ? await readClientSecret() : undefined

    await addMcpConfig(name, parsedJson, scope)

    const transportType =
      parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson
        ? String(parsedJson.type || 'stdio')
        : 'stdio'

    if (
      clientSecret &&
      parsedJson &&
      typeof parsedJson === 'object' &&
      'type' in parsedJson &&
      (parsedJson.type === 'sse' || parsedJson.type === 'http') &&
      'url' in parsedJson &&
      typeof parsedJson.url === 'string'
    ) {
      saveMcpClientSecret(
        name,
        { type: parsedJson.type, url: parsedJson.url },
        clientSecret,
      )
    }

    logEvent('tengu_mcp_add', {
      scope:
        scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      type: transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(`Added ${transportType} MCP server ${name} to ${scope} config`)
  } catch (error) {
    cliError((error as Error).message)
  }
}

// mcp add-from-claude-desktop (lines 4881–4927)
export async function mcpAddFromDesktopHandler(options: {
  scope?: string
}): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope)
    const platform = getPlatform()

    logEvent('tengu_mcp_add', {
      scope:
        scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      platform:
        platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'desktop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    const { readClaudeDesktopMcpServers } = await import(
      '../../utils/claudeDesktop.js'
    )
    const servers = await readClaudeDesktopMcpServers()

    if (Object.keys(servers).length === 0) {
      cliOk(
        'No MCP servers found in Claude Desktop configuration or configuration file does not exist.',
      )
    }

    const { unmount } = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <MCPServerDesktopImportDialog
            servers={servers}
            scope={scope}
            onDone={() => {
              unmount()
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
      { exitOnCtrlC: true },
    )
  } catch (error) {
    cliError((error as Error).message)
  }
}

// mcp reset-project-choices (lines 4935–4952)
export async function mcpResetChoicesHandler(): Promise<void> {
  logEvent('tengu_mcp_reset_mcpjson_choices', {})
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
  }))
  // Approvals given in the session are stored in .claude/settings.local.json.
  const local = getSettingsForSource('localSettings')
  if (
    local?.enabledMcpjsonServers !== undefined ||
    local?.disabledMcpjsonServers !== undefined ||
    local?.enableAllProjectMcpServers !== undefined
  ) {
    const { error } = updateSettingsForSource('localSettings', {
      enabledMcpjsonServers: undefined,
      disabledMcpjsonServers: undefined,
      enableAllProjectMcpServers: undefined,
    })
    if (error) {
      cliError(
        `Error: Failed to reset project choices: ${error.message} (legacy approvals in ~/.claude.json were cleared; local settings were not)`,
      )
    }
  }
  cliOk(
    'Project-scoped (.mcp.json) server approvals and rejections stored for this project have been reset.',
  )
}
