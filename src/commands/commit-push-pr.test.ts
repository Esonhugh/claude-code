import { expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_COMMIT_PROMPT_TEST_CHILD'

if (!process.env[childFlag]) {
  test('checks instruction guidance without executing shell commands', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'commit-prompt-')))
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
  const attribution = await import('../utils/attribution.js')
  const git = await import('../utils/git.js')
  mock.module('../utils/attribution.js', () => ({
    ...attribution,
    getAttributionTexts: () => ({ commit: '', pr: '' }),
    getEnhancedPRAttribution: async () => undefined,
  }))
  mock.module('../utils/git.js', () => ({
    ...git,
    getDefaultBranch: async () => 'main',
  }))
  mock.module('../utils/promptShellExecution.js', () => ({
    executeShellCommandsInPrompt: async (prompt: string) => prompt,
  }))

  const { default: command } = await import('./commit-push-pr.js')

  test('checks both project instruction filenames for Slack guidance', async () => {
    const blocks = await command.getPromptForCommand('', {} as never)
    const prompt = blocks
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')

    expect(prompt).toContain(
      'check if AGENTS.md or CLAUDE.md instructions mention posting to Slack channels',
    )
  })
}
