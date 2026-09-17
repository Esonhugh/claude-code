import { createHash } from 'node:crypto'
import type { PrepareModPluginsSettings } from './plugins.js'
import type { ModPluginInput } from './runtime.js'
import type { ModDeclaration } from './types.js'

export const SEC_DEFAULT_ID = 'sec-default@builtin'

// Local implementation of the supported sec-default event contracts. This is
// embedded source, not an installed plugin path, so packaged hosts own its code.
const source = `export function register(on) {
  let pendingPolicy, expires = 0;
  for (const name of ['classic.*', 'prompt.section', 'prompt.context', 'skill.prompt', 'attribution.text', 'settings.read']) {
    on(name, ($, event, next) => next.to(event, 'append'));
  }
  for (const name of ['tool.describe', 'command.describe', 'agent.offer', 'agent.spawn']) {
    on(name, ($, event, next) => {
      if (['user', 'builtin', 'core'].includes(event.provider?.tier)) return next(event);
      return next.to(event, 'append');
    });
  }
  on('tool.register', async ($, event, next) => {
    if (next.origin.tier === 'prepend' || next.origin.tier === 'append') return next.to(event, 'append');
    if (next.origin.tier === 'user') {
      if (!pendingPolicy || Date.now() > expires) {
        expires = Date.now() + 500;
        pendingPolicy = $.settings.read({source:'policy'});
      }
      const policy = await pendingPolicy.catch(() => undefined);
      if (!policy || Array.isArray(policy.allowedMcpServers)) return {deny:'Managed allowedMcpServers policy does not permit user plugin tool registration'};
    }
    return next(event);
  });
  on('tool.list', async ($, event, next) => {
    if (!pendingPolicy || Date.now() > expires) {
      expires = Date.now() + 500;
      pendingPolicy = $.settings.read({source:'policy'});
    }
    const policy = await pendingPolicy.catch(() => undefined);
    const managed = await next.to(event, 'append');
    const ordinary = await next(event);
    if (!policy || !Array.isArray(managed.value) || !Array.isArray(ordinary.value)) return managed;
    const prefixes = new Set();
    for (const entry of Array.isArray(policy.allowedMcpServers) ? policy.allowedMcpServers : []) {
      if (typeof entry?.serverName === 'string' && entry.serverName) prefixes.add('mcp__' + entry.serverName + '__');
    }
    if (policy.managedMcpServers && typeof policy.managedMcpServers === 'object' && !Array.isArray(policy.managedMcpServers)) {
      for (const server of Object.keys(policy.managedMcpServers)) prefixes.add('mcp__' + server + '__');
    }
    const tools = [];
    for (const [listing, keepManaged] of [[managed.value, true], [ordinary.value, false]]) {
      for (const tool of listing) {
        const belongsToPolicy = [...prefixes].some(prefix => tool.name.startsWith(prefix));
        if (belongsToPolicy === keepManaged) tools.push(tool);
      }
    }
    return {value:tools};
  });
}`
const events = [
  'classic.*',
  'prompt.section',
  'prompt.context',
  'skill.prompt',
  'attribution.text',
  'settings.read',
  'tool.register',
  'tool.list',
  'tool.describe',
  'command.describe',
  'agent.offer',
  'agent.spawn',
]
const entry = 'builtin:sec-default/register.js'
const builtin: ModDeclaration = {
  name: 'sec-default',
  storageId: SEC_DEFAULT_ID,
  isNative: true,
  pluginRoot: 'builtin:sec-default',
  entrypoints: [entry],
  modules: [{ path: entry, source }],
  links: [],
  events,
  calls: ['settings.read'],
  nextTiers: ['append'],
  options: {},
  tier: 'prepend',
  fingerprint: createHash('sha256').update(source).digest('hex'),
}
const seats = new WeakMap<ModPluginInput, ModDeclaration>()

/** Only host-created seats bypass file loading; manifest fields cannot mint one. */
export function getNativeModDeclaration(
  input: ModPluginInput,
): ModDeclaration | undefined {
  return seats.get(input)
}

export function shouldSeatSecDefault(
  settings: PrepareModPluginsSettings,
): boolean {
  if (
    settings.hookPolicy.allDisabled ||
    settings.policySettings?.disableAllHooks
  )
    return false
  const managed =
    settings.hasManagedSettings === true ||
    (settings.policySettings !== null &&
      Object.keys(settings.policySettings).length > 0)
  const list = managed ? settings.policySettings?.prependPlugins : undefined
  return list !== undefined
    ? list.includes(SEC_DEFAULT_ID)
    : managed ||
        settings.subscriptionType === 'team' ||
        settings.subscriptionType === 'enterprise'
}

/**
 * Apply the host's native seat after external declarations have been prepared.
 * An alternate declaration is a trusted embedding-host implementation, never a
 * plugin manifest, setting, or CLI path. It uses the very same seating policy.
 */
export function seatNativeModPlugins(
  inputs: readonly ModPluginInput[],
  settings: PrepareModPluginsSettings,
  implementation: ModDeclaration = builtin,
): ModPluginInput[] {
  if (!shouldSeatSecDefault(settings)) return [...inputs]
  const list = settings.policySettings?.prependPlugins
  const declaration: ModDeclaration = {
    ...implementation,
    name: 'sec-default',
    storageId: SEC_DEFAULT_ID,
    isNative: true,
    tier: 'prepend',
  }
  const input: ModPluginInput = Object.freeze({
    name: declaration.name,
    storageId: declaration.storageId,
    pluginRoot: declaration.pluginRoot,
    entrypoints: declaration.entrypoints,
    tier: declaration.tier,
    isNative: true,
  })
  seats.set(input, declaration)
  const result = [...inputs]
  const position =
    list === undefined
      ? 0
      : result.findIndex(candidate => {
          if (candidate.tier !== 'prepend') return true
          const index = list.indexOf(candidate.storageId)
          return index === -1 || index > list.indexOf(SEC_DEFAULT_ID)
        })
  result.splice(position === -1 ? result.length : position, 0, input)
  return result
}
