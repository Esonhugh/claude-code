import React, { useMemo } from 'react'
import {
  getMcpConfigsByScope,
  getMcpServerSignature,
} from 'src/services/mcp/config.js'
import type {
  ConfigScope,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  getScopeLabel,
} from 'src/services/mcp/utils.js'
import type { ValidationError } from 'src/utils/settings/validation.js'
import { Box, Link, Text } from '../../ink.js'

function McpConfigErrorSection({
  scope,
  parsingErrors,
  warnings,
}: {
  scope: ConfigScope
  parsingErrors: ValidationError[]
  warnings: ValidationError[]
}): React.ReactNode {
  const hasErrors = parsingErrors.length > 0
  const hasWarnings = warnings.length > 0

  if (!hasErrors && !hasWarnings) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {(hasErrors || hasWarnings) && (
          <Text color={hasErrors ? 'error' : 'warning'}>
            [{hasErrors ? 'Failed to parse' : 'Contains warnings'}]{' '}
          </Text>
        )}
        <Text>{getScopeLabel(scope)}</Text>
      </Box>
      <Box>
        <Text dimColor>Location: </Text>
        <Text dimColor>{describeMcpConfigFilePath(scope)}</Text>
      </Box>
      <Box marginLeft={1} flexDirection="column">
        {parsingErrors.map((error, i) => {
          const serverName = error.mcpErrorMetadata?.serverName
          return (
            <Box key={`error-${i}`}>
              <Text>
                <Text dimColor>└ </Text>
                <Text color="error">[Error]</Text>
                <Text dimColor>
                  {' '}
                  {serverName && `[${serverName}] `}
                  {error.path && error.path !== '' ? `${error.path}: ` : ''}
                  {error.message}
                </Text>
              </Text>
            </Box>
          )
        })}
        {warnings.map((warning, i) => {
          const serverName = warning.mcpErrorMetadata?.serverName

          return (
            <Box key={`warning-${i}`}>
              <Text>
                <Text dimColor>└ </Text>
                <Text color="warning">[Warning]</Text>
                <Text dimColor>
                  {' '}
                  {serverName && `[${serverName}] `}
                  {warning.path && warning.path !== ''
                    ? `${warning.path}: `
                    : ''}
                  {warning.message}
                </Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export function McpParsingWarnings(): React.ReactNode {
  // Config files don't change during dialog lifetime; read once on mount
  // to avoid blocking file IO on every re-render.
  const scopes = useMemo(
    () =>
      [
        { scope: 'user', config: getMcpConfigsByScope('user') },
        { scope: 'project', config: getMcpConfigsByScope('project') },
        { scope: 'local', config: getMcpConfigsByScope('local') },
        { scope: 'enterprise', config: getMcpConfigsByScope('enterprise') },
      ] satisfies Array<{
        scope: ConfigScope
        config: {
          servers: Record<string, ScopedMcpServerConfig>
          errors: ValidationError[]
        }
      }>,
    [],
  )

  const hasParsingErrors = scopes.some(
    ({ config }) => filterErrors(config.errors, 'fatal').length > 0,
  )
  const hasWarnings = scopes.some(
    ({ config }) => filterErrors(config.errors, 'warning').length > 0,
  )

  const conflicts = getScopeConflicts(scopes)

  if (!hasParsingErrors && !hasWarnings && conflicts.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold>MCP Config Diagnostics</Text>
      <Box marginTop={1}>
        <Text dimColor>
          For help configuring MCP servers, see:{' '}
          <Link url="https://code.claude.com/docs/en/mcp">
            https://code.claude.com/docs/en/mcp
          </Link>
        </Text>
      </Box>
      {scopes.map(({ scope, config }) => (
        <McpConfigErrorSection
          key={scope}
          scope={scope}
          parsingErrors={filterErrors(config.errors, 'fatal')}
          warnings={filterErrors(config.errors, 'warning')}
        />
      ))}
      {conflicts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="warning">[Conflicting scopes]</Text>
          {conflicts.map(({ name, message, suggestion }) => (
            <Box key={name} flexDirection="column">
              <Text>
                <Text dimColor>├ </Text>
                {message}
              </Text>
              <Text dimColor>└ {suggestion}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

// Same name in several scopes with different endpoints (official 2.1.329).
function getScopeConflicts(
  scopes: Array<{
    scope: ConfigScope
    config: { servers: Record<string, ScopedMcpServerConfig> }
  }>,
): Array<{ name: string; message: string; suggestion: string }> {
  const byName = new Map<
    string,
    Array<{ scope: ConfigScope; signature: string; endpoint: string }>
  >()
  for (const { scope, config } of scopes) {
    for (const [name, server] of Object.entries(config.servers)) {
      const signature = getMcpServerSignature(server)
      if (!signature) continue
      const endpoint =
        'url' in server
          ? server.url
          : 'command' in server
            ? [server.command, ...(server.args ?? [])].join(' ')
            : signature
      const definitions = byName.get(name) ?? []
      definitions.push({ scope, signature, endpoint })
      byName.set(name, definitions)
    }
  }
  return [...byName].flatMap(([name, definitions]) => {
    if (new Set(definitions.map(d => d.signature)).size < 2) return []
    const removable = /^\w[\w.@-]*$/.test(name)
    return {
      name,
      message: `Server "${name}" is defined in multiple scopes with different endpoints: ${definitions.map(d => `${d.scope} (${d.endpoint})`).join(', ')}. OAuth tokens are stored per endpoint, so authenticating in one context will not carry over.`,
      suggestion: removable
        ? `Keep the correct endpoint and remove the others: ${definitions.map(d => `\`claude mcp remove ${name} -s ${d.scope}\``).join(' or ')}`
        : 'Keep the correct endpoint and remove the others from the scopes listed above.',
    }
  })
}

function filterErrors(
  errors: ValidationError[],
  severity: 'fatal' | 'warning',
): ValidationError[] {
  return errors.filter(e => e.mcpErrorMetadata?.severity === severity)
}
