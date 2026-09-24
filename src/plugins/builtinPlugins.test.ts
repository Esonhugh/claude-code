import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearBuiltinPlugins,
  getBuiltinPlugins,
  registerBuiltinPlugin,
} from './builtinPlugins.js'

describe('builtin plugin registry', () => {
  afterEach(() => clearBuiltinPlugins())

  test('preserves a filesystem-backed plugin manifest and module descriptors', () => {
    const root = '/opt/claude/builtin-mods/agents-md'
    const manifest = {
      name: 'agents-md',
      version: '0.1.0',
      description: 'Official AGENTS.md support',
      author: { name: 'Anthropic' },
      userConfig: {
        instructionFiles: {
          type: 'string' as const,
          title: 'Project instructions',
          description: 'Instruction source selection',
          default: 'claude-md-or-agents-md',
          options: [
            'claude-md',
            'claude-md-or-agents-md',
            'claude-md-and-agents-md',
            'managed-only',
          ],
        },
      },
    }
    const hookModules = [{
      configPath: `${root}/hooks/hooks.json`,
      paths: ['./register.ts'],
    }]

    registerBuiltinPlugin({
      name: manifest.name,
      description: manifest.description,
      manifest,
      path: root,
      hookModules,
    })

    const { enabled, disabled } = getBuiltinPlugins()

    expect(disabled).toEqual([])
    expect(enabled).toEqual([expect.objectContaining({
      name: 'agents-md',
      manifest,
      path: root,
      source: 'agents-md@builtin',
      repository: 'agents-md@builtin',
      enabled: true,
      isBuiltin: true,
      hookModules,
    })])
  })
})
