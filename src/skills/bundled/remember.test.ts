import { expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_REMEMBER_PROMPT_TEST_CHILD'

if (!process.env[childFlag]) {
  test('audits instruction layers in an isolated skill registry', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'remember-prompt-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          DISABLE_AUTOUPDATER: '1',
          [childFlag]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  const { getBundledSkills } = await import('../bundledSkills.js')
  const { registerRememberSkill } = await import('./remember.js')

  // Load the external-user dependency graph before enabling this internal skill.
  mock.module('src/utils/userType.js', () => ({
    isAnt: () => true,
    userType: () => 'ant',
  }))

  test('audits AGENTS.md and CLAUDE.md as coexisting instruction layers', async () => {
    registerRememberSkill()
    const skill = getBundledSkills().find(
      candidate => candidate.name === 'remember',
    )
    expect(skill?.type).toBe('prompt')
    if (skill?.type !== 'prompt')
      throw new Error('remember skill was not registered')

    const blocks = await skill.getPromptForCommand('', {} as never)
    const prompt = blocks
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')

    expect(prompt).toContain(
      'Read AGENTS.md, CLAUDE.md, and CLAUDE.local.md from the project root',
    )
    expect(prompt).toContain('| **AGENTS.md** |')
    expect(prompt).toContain('| **CLAUDE.md** |')
    expect(prompt).toMatch(/\*\*Duplicates\*\*:.*AGENTS\.md.*CLAUDE\.md/)
    expect(prompt).toMatch(/\*\*Outdated\*\*:.*AGENTS\.md.*CLAUDE\.md/)
    expect(prompt).toMatch(/\*\*Conflicts\*\*:.*AGENTS\.md.*CLAUDE\.md/)
    expect(skill.description).toContain('AGENTS.md')
    expect(skill.whenToUse).toContain('AGENTS.md')
  })
}
