import { afterAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const childFlag = 'CLAUDE_CODE_IN_PROCESS_BACKEND_MAILBOX_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('in-process executor mailbox failures (isolated)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], { env: { ...process.env, [childFlag]: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw Error(`${stdout}\n${stderr}`)
  })
} else {
  const config = await mkdtemp(join(tmpdir(), 'in-process-backend-mailbox-'))
  process.env.CLAUDE_CONFIG_DIR = config
  afterAll(async () => { await rm(config, { recursive: true, force: true }) })
  const { getInboxPath } = await import('../../teammateMailbox.js')
  const { InProcessBackend } = await import('./InProcessBackend.js')
  const { getDefaultAppState } = await import('../../../state/AppStateStore.js')

  async function blockedBackend() {
    const inbox = getInboxPath('worker', 'exec-team')
    await mkdir(inbox, { recursive: true }); await writeFile(join(inbox, 'block'), 'fixture')
    let state = {
      ...getDefaultAppState(),
      tasks: { t1: { type: 'in_process_teammate', id: 't1', status: 'running', shutdownRequested: false,
        identity: { agentId: 'worker@exec-team', agentName: 'worker', teamName: 'exec-team' } } },
    } as unknown as ReturnType<typeof getDefaultAppState>
    const backend = new InProcessBackend()
    backend.setContext({ getAppState: () => state, setAppState: (update: (prev: typeof state) => typeof state) => { state = update(state) } } as never)
    return { backend, state: () => state as unknown as { tasks: Record<string, { shutdownRequested: boolean }> } }
  }

  test('terminate reports failure and leaves no pending shutdown when the request was not written', async () => {
    const { backend, state } = await blockedBackend()
    expect(await backend.terminate('worker@exec-team', 'done')).toBe(false)
    expect(state().tasks.t1!.shutdownRequested).toBe(false)
  })

  test('sendMessage rejects when the message was not written', async () => {
    const { backend } = await blockedBackend()
    await expect(backend.sendMessage('worker@exec-team', { text: 'look again', from: 'team-lead' })).rejects.toThrow(/inbox/)
  })
}
