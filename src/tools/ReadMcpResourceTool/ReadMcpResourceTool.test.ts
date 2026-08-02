import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import {
  createMcpSkillResourceRules,
  readMcpSkillResourceRules,
} from '../../skills/mcpSkillResourceGrant.js'
import { ReadMcpResourceTool } from './ReadMcpResourceTool.js'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function connectedServer(
  request: () => Promise<unknown>,
  name = 'skills',
): ConnectedMCPServer {
  return {
    name,
    type: 'connected',
    capabilities: { resources: {} },
    config: { type: 'sdk', name, scope: 'local' },
    client: { request } as unknown as ConnectedMCPServer['client'],
    cleanup: async () => {},
  }
}

function context(
  server: ConnectedMCPServer,
  rules: string[],
): Parameters<typeof ReadMcpResourceTool.checkPermissions>[1] {
  return {
    options: { mcpClients: [server] },
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        alwaysAllowRules: { command: rules },
        alwaysDenyRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
        isBypassPermissionsModeAvailable: false,
      },
    }),
  } as never
}

describe('ReadMcpResourceTool MCP skill scope', () => {
  it('round-trips host-generated resource permission rules through the standard parser', () => {
    const uri = 'skill://demo/templates/(draft).md'
    const digest = sha256('# Draft')
    const rules = createMcpSkillResourceRules('skills(test)', 'skill://demo/SKILL.md', [
      { uri, digest },
    ])

    assert.deepEqual(readMcpSkillResourceRules(rules), {
      scoped: true,
      scopes: [
        { server: 'skills(test)', skillUri: 'skill://demo/SKILL.md' },
      ],
      grants: [
        {
          server: 'skills(test)',
          skillUri: 'skill://demo/SKILL.md',
          uri,
          digest,
        },
      ],
    })
  })

  it('ignores grants that are not paired with their skill scope', async () => {
    const uri = 'skill://other/private.md'
    const digest = sha256('# Private')
    const scopeRule = createMcpSkillResourceRules(
      'skills',
      'skill://active/SKILL.md',
      [],
    )[0]!
    const resourceRule = createMcpSkillResourceRules(
      'skills',
      'skill://other/SKILL.md',
      [{ uri, digest }],
    )[1]!

    assert.deepEqual(
      readMcpSkillResourceRules([scopeRule, resourceRule]),
      {
        scoped: true,
        scopes: [
          { server: 'skills', skillUri: 'skill://active/SKILL.md' },
        ],
        grants: [
          {
            server: 'skills',
            skillUri: 'skill://other/SKILL.md',
            uri,
            digest,
          },
        ],
      },
    )
    assert.equal(
      (
        await ReadMcpResourceTool.checkPermissions(
          { server: 'skills', uri },
          context(connectedServer(async () => ({ contents: [] })), [
            scopeRule,
            resourceRule,
          ]),
        )
      ).behavior,
      'deny',
    )
  })

  it('allows exact manifest resources and denies unlisted or cross-server reads', async () => {
    const uri = 'skill://demo/reference.md'
    const server = connectedServer(async () => ({ contents: [] }))
    const rules = createMcpSkillResourceRules('skills', 'skill://demo/SKILL.md', [
      { uri, digest: sha256('# Reference') },
    ])
    const ctx = context(server, rules)

    assert.equal(
      (await ReadMcpResourceTool.checkPermissions({ server: 'skills', uri }, ctx))
        .behavior,
      'allow',
    )
    assert.equal(
      (
        await ReadMcpResourceTool.checkPermissions(
          { server: 'skills', uri: 'skill://demo/unlisted.md' },
          ctx,
        )
      ).behavior,
      'deny',
    )
    assert.equal(
      (
        await ReadMcpResourceTool.checkPermissions(
          { server: 'other', uri },
          ctx,
        )
      ).behavior,
      'deny',
    )
  })

  it('keeps generic reads unchanged when no MCP skill scope is active', async () => {
    const server = connectedServer(async () => ({ contents: [] }))
    const decision = await ReadMcpResourceTool.checkPermissions(
      { server: 'skills', uri: 'resource://generic' },
      context(server, []),
    )

    assert.equal(decision.behavior, 'allow')
  })

  it('verifies every returned text resource before exposing it', async () => {
    const uri = 'skill://demo/reference.md'
    const text = '# Reference'
    const server = connectedServer(async () => ({
      contents: [{ uri, text }, { uri: 'skill://demo/extra.md', text: '# Extra' }],
    }))
    const rules = createMcpSkillResourceRules('skills', 'skill://demo/SKILL.md', [
      { uri, digest: sha256(text) },
    ])
    const ctx = context(server, rules)

    await assert.rejects(
      ReadMcpResourceTool.call({ server: 'skills', uri }, ctx),
      /not listed in the active MCP skill manifest/,
    )
  })

  it('requires the server response to contain the requested resource', async () => {
    const uri = 'skill://demo/reference.md'
    const extraUri = 'skill://demo/extra.md'
    const extraText = '# Extra'
    const server = connectedServer(async () => ({
      contents: [{ uri: extraUri, text: extraText }],
    }))
    const rules = createMcpSkillResourceRules('skills', 'skill://demo/SKILL.md', [
      { uri, digest: sha256('# Reference') },
      { uri: extraUri, digest: sha256(extraText) },
    ])
    const ctx = context(server, rules)

    await assert.rejects(
      ReadMcpResourceTool.call({ server: 'skills', uri }, ctx),
      /did not return requested resource/,
    )
  })

  it('rejects text digest mismatches before returning model-visible data', async () => {
    const uri = 'skill://demo/reference.md'
    const server = connectedServer(async () => ({
      contents: [{ uri, text: '# Changed' }],
    }))
    const rules = createMcpSkillResourceRules('skills', 'skill://demo/SKILL.md', [
      { uri, digest: sha256('# Expected') },
    ])
    const ctx = context(server, rules)

    await assert.rejects(
      ReadMcpResourceTool.call({ server: 'skills', uri }, ctx),
      /digest mismatch/,
    )
  })

  it('rejects malformed base64 blobs before persistence', async () => {
    const uri = 'skill://demo/data.bin'
    const server = connectedServer(async () => ({
      contents: [{ uri, blob: 'not-base64' }],
    }))
    const rules = createMcpSkillResourceRules('skills', 'skill://demo/SKILL.md', [
      { uri, digest: sha256(Buffer.alloc(0)) },
    ])
    const ctx = context(server, rules)

    await assert.rejects(
      ReadMcpResourceTool.call({ server: 'skills', uri }, ctx),
      /Invalid MCP skill resource blob encoding/,
    )
  })

  it('verifies decoded blob bytes before persistence', async () => {
    const uri = 'skill://demo/data.bin'
    const bytes = Buffer.from([0, 1, 2, 3])
    const server = connectedServer(async () => ({
      contents: [{ uri, blob: bytes.toString('base64') }],
    }))
    const rules = createMcpSkillResourceRules('skills', 'skill://demo/SKILL.md', [
      { uri, digest: sha256(Buffer.from([9, 9, 9])) },
    ])
    const ctx = context(server, rules)

    await assert.rejects(
      ReadMcpResourceTool.call({ server: 'skills', uri }, ctx),
      /digest mismatch/,
    )
  })
})
