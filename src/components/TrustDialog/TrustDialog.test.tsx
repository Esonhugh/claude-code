import { expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_TRUST_DIALOG_TEST_CHILD'

if (process.env[childFlag] === undefined) {
  // The dialog reads process-wide settings, config and .mcp.json.
  for (const scenario of ['mcp', 'plain']) {
    test(`trust dialog in an untrusted folder: ${scenario} (isolated)`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'trust-dialog-')))
      try {
        mkdirSync(join(root, 'project'), { recursive: true })
        if (scenario === 'mcp') {
          writeFileSync(join(root, 'project', '.mcp.json'), JSON.stringify({ mcpServers: { srv: { command: 'true' } } }))
        }
        const child = Bun.spawn([process.execPath, 'test', '--no-env-file', import.meta.path], {
          cwd: join(root, 'project'),
          env: { PATH: process.env.PATH, [childFlag]: scenario, HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'),
            TMPDIR: root, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
          stdout: 'pipe', stderr: 'pipe',
        })
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 120_000)
  }
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
  const { setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
  const { enableConfigs } = await import('../../utils/config.js')
  const { Readable, Writable } = await import('node:stream')
  const shutdowns: unknown[][] = []
  const actualShutdown = await import('../../utils/gracefulShutdown.js')
  mock.module('../../utils/gracefulShutdown.js', () => ({
    ...actualShutdown,
    gracefulShutdownSync: (...args: unknown[]) => { shutdowns.push(args) },
  }))
  const { render } = await import('../../ink.js')
  const { default: instances } = await import('../../ink/instances.js')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
  const { TrustDialog } = await import('./TrustDialog.js')
  type Node = { nodeName: string; nodeValue: string; childNodes: Node[] }

  setOriginalCwd(process.cwd())
  setCwdState(process.cwd())
  enableConfigs()

  class Input extends Readable { isTTY = true; _read() {}; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  class Output extends Writable { columns = 110; rows = 40; isTTY = true; _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() } }
  const contents = (node: Node): string => node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(contents).join('')

  // Same wrappers as showSetupDialog.
  async function dialog(keys?: string): Promise<string> {
    const stdout = new Output()
    const stdin = new Input()
    const instance = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <TrustDialog onDone={() => {}} />
        </KeybindingSetup>
      </AppStateProvider>,
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    try {
      const root = () => (instances.get(stdout as never) as unknown as { rootNode: Node }).rootNode
      const deadline = Date.now() + 3000
      while (!contents(root()).includes('No, exit') && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
      if (keys) {
        stdin.push(keys)
        while (shutdowns.length === 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
      }
      return contents(root())
    } finally {
      instance.unmount()
    }
  }

  test('No is listed first and focused, so a bare Enter does not trust the folder', async () => {
    const text = await dialog()
    expect(text).toMatch(/❯\s*No, exit\s*Yes, I trust this folder/)
  })

  test('.mcp.json servers are named as something trusting the folder loads', async () => {
    const text = await dialog()
    const line = 'Trusting this folder loads .mcp.json here or above (MCP servers).'
    if (process.env[childFlag] === 'mcp') expect(text).toContain(line)
    else expect(text).not.toContain('Trusting this folder loads')
  })

  test('a bare Enter exits and says the folder is not trusted', async () => {
    shutdowns.length = 0
    await dialog('\r')
    expect(shutdowns).toEqual([[1, 'other', {
      finalMessage: "Claude Code didn't start because this folder isn't trusted.\nRun claude again and choose Yes, or run it in another folder.",
    }]])
  })
}
