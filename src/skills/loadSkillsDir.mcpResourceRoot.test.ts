import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSkillCommand } from './loadSkillsDir.js'

function commandWithResourceRoot(
  mcpResourceRoot: {
    server: string
    uri: string
    directoryRead: boolean
  },
  baseDir?: string,
) {
  return createSkillCommand({
    skillName: 'server:demo',
    displayName: undefined,
    description: 'Demo skill',
    hasUserSpecifiedDescription: true,
    markdownContent: '# Demo\n\nRead templates/invoice.md.',
    allowedTools: [],
    argumentHint: undefined,
    argumentNames: [],
    whenToUse: undefined,
    version: undefined,
    model: undefined,
    disableModelInvocation: false,
    userInvocable: true,
    source: 'mcp',
    baseDir,
    mcpResourceRoot,
    loadedFrom: 'mcp',
    hooks: undefined,
    executionContext: undefined,
    agent: undefined,
    paths: undefined,
    effort: undefined,
    shell: undefined,
  })
}

describe('createSkillCommand MCP resource root', () => {
  it('explains how to read supporting MCP resources', async () => {
    const command = commandWithResourceRoot({
      server: 'community_skills',
      uri: 'skill://demo',
      directoryRead: false,
    })

    assert.equal(command.type, 'prompt')
    if (command.type !== 'prompt') return
    const [prompt] = await command.getPromptForCommand('', {} as never)
    const text = prompt?.type === 'text' ? prompt.text : ''

    assert.match(
      text,
      /This skill is served by MCP server "community_skills" at skill:\/\/demo\./,
    )
    assert.match(text, /ReadMcpResourceTool/)
    assert.match(text, /skill:\/\/demo\/templates\/invoice\.md/)
    assert.doesNotMatch(text, /ReadMcpResourceDirTool/)
  })

  it('mentions directory listing only when declared', async () => {
    const command = commandWithResourceRoot({
      server: 'community_skills',
      uri: 'skill://demo',
      directoryRead: true,
    })

    assert.equal(command.type, 'prompt')
    if (command.type !== 'prompt') return
    const [prompt] = await command.getPromptForCommand('', {} as never)
    const text = prompt?.type === 'text' ? prompt.text : ''

    assert.match(text, /ReadMcpResourceDirTool/)
    assert.match(text, /skill:\/\/demo/)
  })

  it('keeps local base directory instructions authoritative', async () => {
    const command = commandWithResourceRoot(
      {
        server: 'community_skills',
        uri: 'skill://demo',
        directoryRead: true,
      },
      '/tmp/local-skill',
    )

    assert.equal(command.type, 'prompt')
    if (command.type !== 'prompt') return
    const [prompt] = await command.getPromptForCommand('', {} as never)
    const text = prompt?.type === 'text' ? prompt.text : ''

    assert.match(text, /Base directory for this skill: \/tmp\/local-skill/)
    assert.doesNotMatch(text, /This skill is served by MCP server/)
  })
})
