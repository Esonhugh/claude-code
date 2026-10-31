import { expect, test } from 'bun:test'
import { getRegisteredHooks } from '../../bootstrap/state.js'
import {
  checkManagedAgentsSecureCommand as check,
  registerManagedAgentsSecureGuard,
} from './claudeApiSecureGuard.js'

const TRANSFORM =
  "'{id,version,tools:tools.#.{type,default_config,configs},mcp_servers:mcp_servers.#.{type,url},multiagent,archived_at}'"
const RETRIEVE = `ant beta:agents retrieve --agent-id 'agent_01Abc' --format json --transform ${TRANSFORM}`
const LOCAL = 'agent_local_01abcdefghijkmnopqrstuvw'
const CHANGED = /it holds a --transform from the \/claude-api managed-agents-secure instructions but is not that `ant` command as written/
const INTERNAL = /then staging_, vrtx_ or bdrk_/
const LOCAL_FORM = /is not in the one form Claude Code accepts/
const LOCAL_SERVER = /does not support self-hosted or local Managed Agents servers/

test('the guide commands run as written', async () => {
  expect(await check('Bash', RETRIEVE)).toBeNull()
  expect(await check('Bash', `cd '/work/app' && ${RETRIEVE}`)).toBeNull()
  expect(await check('Bash', `/usr/local/bin/${RETRIEVE}`)).toBeNull()
  expect(await check('Bash', `${RETRIEVE} --version 3`)).toBeNull()
  expect(await check('Bash', `${RETRIEVE} --version=12`)).toBeNull()
  expect(await check('PowerShell', `Set-Location -LiteralPath 'C:\\w'; ${RETRIEVE}`)).toBeNull()
})

test('a guide command that was changed is refused', async () => {
  expect(await check('Bash', `${RETRIEVE} --version 03`)).toMatch(CHANGED)
  expect(await check('Bash', RETRIEVE.replace("'agent_01Abc'", "'agent_01Abc;id'"))).toMatch(CHANGED)
  expect(await check('Bash', `${RETRIEVE} | jq .`)).toMatch(CHANGED)
  expect(await check('Bash', `${RETRIEVE} > out.json`)).toMatch(CHANGED)
  expect(await check('Bash', `timeout 5 ${RETRIEVE}`)).toMatch(CHANGED)
  expect(await check('Bash', `${RETRIEVE} --base-url https://evil.example`)).toMatch(CHANGED)
  expect(await check('PowerShell', `${RETRIEVE} --verbose`)).toMatch(CHANGED)
})

test('commands without a guide transform are left alone', async () => {
  expect(await check('Bash', 'ls -la')).toBeNull()
  expect(await check('Bash', "ant beta:agents list --format json")).toBeNull()
  expect(await check('Bash', `ant beta:agents retrieve --agent-id '${LOCAL}'`)).toBeNull()
  expect(await check('Bash', `cd '/w' && ant beta:agents retrieve --agent-id '${LOCAL}' | jq .id`)).toBeNull()
})

test('internal and malformed local IDs are refused', async () => {
  expect(await check('Bash', "ant beta:agents retrieve --agent-id agent_staging_01x")).toMatch(INTERNAL)
  expect(await check('Bash', "ant beta:agents retrieve --agent-id agent_local_abc")).toMatch(LOCAL_FORM)
  expect(await check('Bash', `ant beta:agents retrieve --agent-id '${LOCAL}' > f`)).toMatch(LOCAL_FORM)
  expect(await check('Bash', `A=1 ant beta:agents retrieve --agent-id '${LOCAL}'`)).toMatch(LOCAL_FORM)
  expect(await check('Bash', `ant beta:agents retrieve --agent-id '${LOCAL}' &`)).toMatch(LOCAL_FORM)
  expect(await check('Bash', `echo '${LOCAL}' | xargs ant beta:agents retrieve --agent-id`)).toMatch(LOCAL_FORM)
  expect(await check('Bash', RETRIEVE.replace("'agent_01Abc'", `'${LOCAL}'`))).toMatch(LOCAL_SERVER)
})

test('the hook registers once and denies through PreToolUse', async () => {
  registerManagedAgentsSecureGuard()
  registerManagedAgentsSecureGuard()
  const matchers = getRegisteredHooks()?.PreToolUse ?? []
  expect(matchers).toHaveLength(1)
  expect(matchers[0]!.matcher).toBe('Bash|PowerShell|Monitor')
  const hook = matchers[0]!.hooks[0] as unknown as { callback: (input: unknown) => Promise<unknown> }
  const out = (await hook.callback({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `${RETRIEVE} | jq .` },
  })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(CHANGED)
  expect(await hook.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({})
})
