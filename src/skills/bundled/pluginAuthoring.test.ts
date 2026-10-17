import { beforeEach, describe, expect, test } from 'bun:test'

import { generateModDeclarationFiles } from '../../services/mods/declarations.js'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import {
  PLUGIN_AUTHORING_FILES,
  pluginAuthoringPrompt,
  registerPluginAuthoringSkill,
} from './pluginAuthoring.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
}

beforeEach(() => clearBundledSkills())

describe('plugin-authoring bundled skill', () => {
  test('registers the exact user-invocable entry with reference attachments', () => {
    registerPluginAuthoringSkill()

    const skill = getBundledSkills().find(
      candidate => candidate.name === 'plugin-authoring',
    )
    expect(skill?.type).toBe('prompt')
    if (skill?.type !== 'prompt') {
      throw new Error('plugin-authoring skill was not registered')
    }
    expect(skill.userInvocable).toBe(true)
    expect(skill.isHidden).toBe(false)
    expect(skill.source).toBe('bundled')
    expect(skill.skillRoot).toEndWith('/plugin-authoring')
  })

  test('appends user arguments without changing the authoring guide', () => {
    const base = pluginAuthoringPrompt('', '/config/dev-mods/session')
    const withRequest = pluginAuthoringPrompt(
      'add a compact status band',
      '/config/dev-mods/session',
    )

    expect(base).toContain('# Plugin Authoring')
    expect(base).toContain('/config/dev-mods/session')
    expect(base).not.toContain('## User Request')
    expect(withRequest).toBe(
      `${base}\n\n## User Request\n\nadd a compact status band`,
    )
  })

  test('requests session consent through the narrow interactive host before exposing the authoring root', async () => {
    registerPluginAuthoringSkill()
    const skill = getBundledSkills().find(
      candidate => candidate.name === 'plugin-authoring',
    )
    if (skill?.type !== 'prompt') throw new Error('skill missing')
    const controller = new AbortController()
    const calls: AbortSignal[] = []
    const blocks = await skill.getPromptForCommand('make one', {
      abortController: controller,
      requestModAuthoringConsent: async signal => {
        calls.push(signal)
        return { enabled: true, root: '/config/dev-mods/session' }
      },
    } as never)

    expect(calls).toEqual([controller.signal])
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/config/dev-mods/session'),
    })
  })

  test('does not fall back to generic hook prompts when the narrow host is absent', async () => {
    registerPluginAuthoringSkill()
    const skill = getBundledSkills().find(
      candidate => candidate.name === 'plugin-authoring',
    )
    if (skill?.type !== 'prompt') throw new Error('skill missing')
    let prompted = false
    const blocks = await skill.getPromptForCommand('', {
      abortController: new AbortController(),
      modsSession: { requestAuthoringConsent: async () => ({ enabled: true, root: '/wrong' }) },
      requestPrompt: () => async () => {
        prompted = true
        return { prompt_response: 'wrong', selected: 'enable' }
      },
    } as never)
    expect(prompted).toBe(false)
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: expect.not.stringContaining('/wrong'),
    })
  })

  test('does not claim session authoring without an interactive Mods host', async () => {
    registerPluginAuthoringSkill()
    const skill = getBundledSkills().find(
      candidate => candidate.name === 'plugin-authoring',
    )
    if (skill?.type !== 'prompt') throw new Error('skill missing')
    const blocks = await skill.getPromptForCommand('', {} as never)
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: expect.not.stringContaining('/dev-mods/'),
    })
  })

  test('keeps the reference consistent with session authoring consent', () => {
    const reference = PLUGIN_AUTHORING_FILES['reference.md']!
    expect(reference).not.toContain('does not provide or promise')
    expect(reference).toContain('Only after the interactive host confirms consent')
    expect(reference).toContain('direct child directories')
    expect(reference).toContain('after the current turn')
    expect(reference).toContain('Not now')
    expect(reference).toContain('clear or fork')
    expect(reference).toContain('does not prove that a plugin loaded successfully')
  })

  test('ships generated declarations and concise authoring references', () => {
    const generated = generateModDeclarationFiles('test')
    const declaration = generated.find(
      file => file.path === 'claude-code/index.d.ts',
    )

    expect(PLUGIN_AUTHORING_FILES['types/claude-code/index.d.ts']).toBe(
      declaration?.text,
    )
    expect(PLUGIN_AUTHORING_FILES['reference.md']).toContain(
      '`.claude-plugin/plugin.json`',
    )
    expect(PLUGIN_AUTHORING_FILES['examples/basic-mod.mjs']).toContain(
      'export function register(on)',
    )
  })
})
