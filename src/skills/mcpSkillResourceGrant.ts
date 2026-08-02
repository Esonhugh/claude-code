import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../utils/permissions/permissionRuleParser.js'

const TOOL_NAME = 'ReadMcpResourceTool'
const SCOPE_PREFIX = 'mcp-skill-scope:'
const RESOURCE_PREFIX = 'mcp-skill-resource:'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

export type McpSkillResourceGrant = {
  server: string
  skillUri: string
  uri: string
  digest: string
}

export type McpSkillResourceScope = {
  server: string
  skillUri: string
}

type McpSkillResource = {
  uri: string
  digest: string
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export function createMcpSkillResourceRules(
  server: string,
  skillUri: string,
  resources: McpSkillResource[],
): string[] {
  const rule = (ruleContent: string) =>
    permissionRuleValueToString({ toolName: TOOL_NAME, ruleContent })
  return [
    rule(`${SCOPE_PREFIX}${encode({ server, skillUri })}`),
    ...resources.map(resource =>
      rule(
        `${RESOURCE_PREFIX}${encode({
          server,
          skillUri,
          uri: resource.uri,
          digest: resource.digest,
        })}`,
      ),
    ),
  ]
}

export function readMcpSkillResourceRules(rules: readonly string[]): {
  scoped: boolean
  scopes: McpSkillResourceScope[]
  grants: McpSkillResourceGrant[]
} {
  const scopes: McpSkillResourceScope[] = []
  const grants: McpSkillResourceGrant[] = []

  for (const rule of rules) {
    const parsed = permissionRuleValueFromString(rule)
    if (parsed.toolName !== TOOL_NAME || !parsed.ruleContent) continue

    if (parsed.ruleContent.startsWith(SCOPE_PREFIX)) {
      const value = decode(parsed.ruleContent.slice(SCOPE_PREFIX.length))
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).server === 'string' &&
        typeof (value as Record<string, unknown>).skillUri === 'string'
      ) {
        scopes.push(value as McpSkillResourceScope)
      }
      continue
    }

    if (!parsed.ruleContent.startsWith(RESOURCE_PREFIX)) continue
    const value = decode(parsed.ruleContent.slice(RESOURCE_PREFIX.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const grant = value as Record<string, unknown>
    if (
      typeof grant.server !== 'string' ||
      typeof grant.skillUri !== 'string' ||
      typeof grant.uri !== 'string' ||
      typeof grant.digest !== 'string' ||
      !DIGEST_PATTERN.test(grant.digest)
    ) {
      continue
    }
    grants.push({
      server: grant.server,
      skillUri: grant.skillUri,
      uri: grant.uri,
      digest: grant.digest,
    })
  }

  return { scoped: scopes.length > 0, scopes, grants }
}

export function replaceMcpSkillResourceRules(
  rules: readonly string[],
  replacements: readonly string[],
): string[] {
  return [
    ...rules.filter(rule => {
      const parsed = permissionRuleValueFromString(rule)
      return (
        parsed.toolName !== TOOL_NAME ||
        !parsed.ruleContent ||
        (!parsed.ruleContent.startsWith(SCOPE_PREFIX) &&
          !parsed.ruleContent.startsWith(RESOURCE_PREFIX))
      )
    }),
    ...replacements,
  ]
}

export function hasOnlyMcpSkillResourceRules(
  server: string,
  rules: readonly string[],
): boolean {
  const { scopes, grants } = readMcpSkillResourceRules(rules)
  const scope = scopes[0]
  return (
    scopes.length === 1 &&
    scope?.server === server &&
    rules.length === grants.length + 1 &&
    grants.every(
      grant =>
        grant.server === server && grant.skillUri === scope.skillUri,
    )
  )
}
