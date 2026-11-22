import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_AGENT_HOOKS_TRUST_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  // Trust, settings paths and config are cached per process.
  test('agent frontmatter hooks in untrusted workspaces (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hooks-trust-')))
    try {
      mkdirSync(join(root, 'project', '.claude', 'agents'), { recursive: true })
      const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
        cwd: join(root, 'project'),
        env: { PATH: process.env.PATH, [childFlag]: '1', HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'),
          TMPDIR: root, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
  const { setCwdState, setIsInteractive, setOriginalCwd, setSessionTrustAccepted } = await import('../../bootstrap/state.js')
  const { enableConfigs, resetTrustDialogAcceptedCacheForTesting } = await import('../../utils/config.js')
  const { agentFrontmatterHooksAllowed } = await import('./runAgent.js')

  setOriginalCwd(process.cwd())
  setCwdState(process.cwd())
  // -p / SDK: no trust dialog is ever shown.
  setIsInteractive(false)
  enableConfigs()

  const agent = (source: string) =>
    ({
      agentType: 'probe',
      whenToUse: 'probe',
      source,
      baseDir: source === 'projectSettings' ? join(process.cwd(), '.claude', 'agents') : undefined,
      getSystemPrompt: () => '',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    }) as never

  test('a project agent in an untrusted folder does not get its frontmatter hooks registered', () => {
    expect(agentFrontmatterHooksAllowed(agent('projectSettings'))).toBe(false)
  })

  test('user, --agents, managed and plugin agents keep their frontmatter hooks', () => {
    for (const source of ['userSettings', 'flagSettings', 'policySettings', 'plugin', 'built-in']) {
      expect(agentFrontmatterHooksAllowed(agent(source))).toBe(true)
    }
  })

  test('a project agent keeps its frontmatter hooks once the folder is trusted', () => {
    setSessionTrustAccepted(true)
    try {
      expect(agentFrontmatterHooksAllowed(agent('projectSettings'))).toBe(true)
    } finally {
      setSessionTrustAccepted(false)
      resetTrustDialogAcceptedCacheForTesting()
    }
  })
}
