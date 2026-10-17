import { expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_DOCTOR_INSTRUCTIONS_TEST_CHILD'

if (!process.env[childFlag]) {
  test('reports large instruction files with isolated context mocks', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'doctor-instructions-')),
    )
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
  const { MAX_MEMORY_CHARACTER_COUNT } = await import('./claudemd.js')
  const memoryFiles = [
    {
      path: '/project/AGENTS.md',
      type: 'Project',
      content: 'x'.repeat(MAX_MEMORY_CHARACTER_COUNT + 1),
    },
  ]

  mock.module('./claudemd.js', () => ({
    getMemoryFiles: async () => memoryFiles,
  }))
  mock.module('./sandbox/sandbox-adapter.js', () => ({
    SandboxManager: {
      isSandboxingEnabled: () => false,
      isAutoAllowBashIfSandboxedEnabled: () => false,
    },
  }))

  const { checkContextWarnings } = await import('./doctorContextWarnings.js')
  const getPermissionContext = async () => ({
    mode: 'default' as const,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

  test.each([
    ['Project', '/project/AGENTS.md'],
    ['AutoMem', '/memory/MEMORY.md'],
    ['TeamMem', '/team/MEMORY.md'],
  ])('uses a neutral context-file title for %s', async (type, path) => {
    const original = memoryFiles[0]!
    memoryFiles[0] = { ...original, type, path }
    try {
      const result = await checkContextWarnings([], null, getPermissionContext)
      expect(result.claudeMdWarning?.message).toMatch(
        /^Large context file detected/,
      )
      expect(result.claudeMdWarning?.details).toEqual([
        expect.stringContaining(path),
      ])
    } finally {
      memoryFiles[0] = original
    }
  })

  test('uses a filename-neutral title for multiple large instruction files', async () => {
    memoryFiles.push({
      path: '/project/CLAUDE.md',
      type: 'Project',
      content: 'y'.repeat(MAX_MEMORY_CHARACTER_COUNT + 1),
    })

    try {
      const result = await checkContextWarnings([], null, getPermissionContext)

      expect(result.claudeMdWarning?.message).toMatch(
        /^2 large context files detected/,
      )
      expect(result.claudeMdWarning?.message).not.toContain('CLAUDE.md files')
      expect(result.claudeMdWarning?.details).toEqual([
        expect.stringContaining('/project/AGENTS.md'),
        expect.stringContaining('/project/CLAUDE.md'),
      ])
    } finally {
      memoryFiles.pop()
    }
  })
}
