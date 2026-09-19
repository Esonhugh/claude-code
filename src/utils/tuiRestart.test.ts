import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import * as state from '../bootstrap/state.js'
import * as shutdown from './gracefulShutdown.js'
import * as sessionStorage from './sessionStorage.js'
import { configureTuiRestart, restartTui } from './tuiRestart.js'
import { createCommandInputMessage } from './messages.js'

const originalArgv = [...process.argv]
const spies: Array<{ mockRestore(): void }> = []

function track<T extends { mockRestore(): void }>(spy: T): T {
  spies.push(spy)
  return spy
}

afterEach(async () => {
  process.argv = [...originalArgv]
  while (spies.length > 0) spies.pop()?.mockRestore()
})

describe('local TUI restart', () => {
  test('restarts the source entry with CLI configuration flags but no prompt or session entry flags', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const command = new Command()
      .argument('[prompt]')
      .option('-d, --debug [filter]', '', () => true)
      .option('--debug-file <path>', '', () => true)
      .option('--dangerously-skip-permissions')
      .option('--settings <file>')
      .option(
        '--plugin-dir <path>',
        '',
        (value: string, previous: string[]) => [...previous, value],
        [] as string[],
      )
      .option('--model <model>')
      .option('--permission-mode <mode>')
      .option('--allowed-tools <tools...>')
      .option('-c, --continue')
      .option('-r, --resume [value]')
      .option('--fork-session')
      .option('--session-id <uuid>')
      .option('--resume-session-at <message-id>')
      .option('--rewind-files <message-id>')
      .option('--worktree [name]')
      .option('--tmux')
      .option('--teleport [session]')
      .option('--remote [description]')

    command.parse(
      (process.argv = [
        'bun',
        'src/cli.ts',
        '--debug=api,hooks',
        '--debug-file',
        'debug.log',
        '--dangerously-skip-permissions',
        '--settings',
        'settings.json',
        '--plugin-dir',
        'plugins/a',
        '--plugin-dir',
        'plugins/b',
        '--model',
        'sonnet',
        '--permission-mode',
        'plan',
        '--allowed-tools',
        'Read',
        'Edit',
        '--continue',
        '--resume',
        'old-session',
        '--fork-session',
        '--session-id',
        '22222222-2222-4222-8222-222222222222',
        '--resume-session-at',
        'message-1',
        '--rewind-files',
        'message-2',
        '--worktree',
        'feature',
        '--tmux',
        '--teleport',
        'remote-session',
        '--remote',
        'task',
        'initial prompt',
      ]),
      { from: 'node' },
    )

    configureTuiRestart(command)

    const flush = track(
      spyOn(sessionStorage, 'persistSessionForRestart').mockResolvedValue(),
    )
    track(spyOn(state, 'getSessionId').mockReturnValue(sessionId as never))
    track(spyOn(state, 'getSessionProjectDir').mockReturnValue(null))
    const gracefulShutdown = track(
      spyOn(shutdown, 'gracefulShutdown').mockResolvedValue(),
    )

    await restartTui([createCommandInputMessage('/tui fullscreen')])

    expect(flush).toHaveBeenCalledTimes(1)
    expect(gracefulShutdown).toHaveBeenCalledWith(0, 'other', {
      restartArgs: [
        resolve(process.cwd(), 'src/cli.ts'),
        '--debug=api,hooks',
        '--debug-file',
        'debug.log',
        '--dangerously-skip-permissions',
        '--settings',
        'settings.json',
        '--plugin-dir',
        'plugins/a',
        '--plugin-dir',
        'plugins/b',
        '--model',
        'sonnet',
        '--permission-mode',
        'plan',
        '--allowed-tools',
        'Read',
        'Edit',
        '--resume',
        sessionId,
      ],
    })
  })

  test('preserves a bare debug flag and an equals-form debug path', async () => {
    const command = new Command()
      .option('-d, --debug [filter]', '', () => true)
      .option('--debug-file <path>', '', () => true)
      .option('--dangerously-skip-permissions')
    process.argv = [
      'bun',
      'src/cli.ts',
      '--debug',
      '--debug-file=/tmp/tui debug.log',
      '--dangerously-skip-permissions',
    ]
    command.parse(process.argv)
    configureTuiRestart(command)
    track(spyOn(sessionStorage, 'persistSessionForRestart').mockResolvedValue())
    track(spyOn(state, 'getSessionProjectDir').mockReturnValue(null))
    const gracefulShutdown = track(
      spyOn(shutdown, 'gracefulShutdown').mockResolvedValue(),
    )

    await restartTui([createCommandInputMessage('/tui fullscreen')])

    const args = gracefulShutdown.mock.calls[0]?.[2]?.restartArgs
    expect(args?.slice(1, 4)).toEqual([
      '--debug',
      '--debug-file=/tmp/tui debug.log',
      '--dangerously-skip-permissions',
    ])
  })

  test('saves current history before resuming the same session ID', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const command = new Command().option('--model <model>')
    process.argv = ['bun', 'src/cli.ts']
    command.parse(['bun', 'src/cli.ts', '--model', 'sonnet'])
    configureTuiRestart(command)

    let saved = false
    const persist = track(
      spyOn(sessionStorage, 'persistSessionForRestart').mockImplementation(
        async () => {
          saved = true
        },
      ),
    )
    track(spyOn(state, 'getSessionId').mockReturnValue(sessionId as never))
    track(spyOn(state, 'getSessionProjectDir').mockReturnValue(null))
    const gracefulShutdown = track(
      spyOn(shutdown, 'gracefulShutdown').mockResolvedValue(),
    )

    const messages = [createCommandInputMessage('/tui fullscreen')]
    gracefulShutdown.mockImplementation(async () => {
      expect(saved).toBe(true)
    })
    await restartTui(messages)

    expect(persist).toHaveBeenCalledWith(messages)
    expect(gracefulShutdown).toHaveBeenCalledWith(0, 'other', {
      restartArgs: [
        resolve(process.cwd(), 'src/cli.ts'),
        '--model',
        'sonnet',
        '--resume',
        sessionId,
      ],
    })
  })

  test('keeps the current process running when the session flush fails', async () => {
    const command = new Command().option('--model <model>')
    process.argv = ['bun', 'src/cli.ts']
    command.parse(['bun', 'src/cli.ts', '--model', 'sonnet'])
    configureTuiRestart(command)

    const error = new Error('flush failed')
    track(
      spyOn(sessionStorage, 'persistSessionForRestart').mockRejectedValue(
        error,
      ),
    )
    const gracefulShutdown = track(
      spyOn(shutdown, 'gracefulShutdown').mockResolvedValue(),
    )

    await expect(
      restartTui([createCommandInputMessage('/tui fullscreen')]),
    ).rejects.toBe(error)
    expect(gracefulShutdown).not.toHaveBeenCalled()
  })

  test('rejects cross-project sessions before flushing', async () => {
    const command = new Command().option('--model <model>')
    process.argv = ['bun', 'src/cli.ts']
    command.parse(['bun', 'src/cli.ts', '--model', 'sonnet'])
    configureTuiRestart(command)

    track(
      spyOn(state, 'getSessionProjectDir').mockReturnValue(
        join(tmpdir(), 'another-project'),
      ),
    )
    const flush = track(
      spyOn(sessionStorage, 'persistSessionForRestart').mockResolvedValue(),
    )

    await expect(
      restartTui([createCommandInputMessage('/tui fullscreen')]),
    ).rejects.toThrow('Cannot restart a session loaded from another project')
    expect(flush).not.toHaveBeenCalled()
  })
})
