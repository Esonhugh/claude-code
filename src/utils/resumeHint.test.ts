import { describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { buildResumeHint, getResumeHintLaunchFlags } from './resumeHint.js'

const ID = '11111111-1111-4111-8111-111111111111'

describe('buildResumeHint', () => {
  test('defaults to the claude launcher', () => {
    expect(buildResumeHint({ sessionId: ID }).command).toBe(
      `claude --resume ${ID}`,
    )
  })

  test.each(['myhost', 'my-host_1'])(
    'uses CLAUDE_CODE_RESUME_HINT_COMMAND=%s as the launcher',
    launcherProgram => {
      expect(
        buildResumeHint({
          sessionId: ID,
          launcherProgram,
          launchFlags: '--dangerously-skip-permissions',
          envAssignment: 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1',
          worktree: { name: 'wt', recordCleared: true },
          columns: 200,
        }).command,
      ).toBe(`${launcherProgram} --resume ${ID}`)
    },
  )

  test.each(['/usr/local/bin/myhost', 'my.host', '-x', ''])(
    'falls back to claude for the unsafe launcher %p',
    launcherProgram => {
      expect(buildResumeHint({ sessionId: ID, launcherProgram }).command).toBe(
        `claude --resume ${ID}`,
      )
    },
  )

  test('replays the launch flags', () => {
    expect(
      buildResumeHint({
        sessionId: ID,
        launchFlags: '--dangerously-skip-permissions',
      }).command,
    ).toBe(`claude --dangerously-skip-permissions --resume ${ID}`)
  })

  test('drops path-like launch flags that do not fit the terminal', () => {
    const launchFlags = '--settings ./s.json'
    expect(
      buildResumeHint({ sessionId: ID, launchFlags, columns: 200 }).command,
    ).toBe(`claude --settings ./s.json --resume ${ID}`)
    expect(
      buildResumeHint({ sessionId: ID, launchFlags, columns: 40 }).command,
    ).toBe(`claude --resume ${ID}`)
    expect(buildResumeHint({ sessionId: ID, launchFlags }).command).toBe(
      `claude --resume ${ID}`,
    )
  })

  test('prefixes the Code Mode variable', () => {
    expect(
      buildResumeHint({
        sessionId: ID,
        envAssignment: 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1',
        launchFlags: '--dangerously-skip-permissions',
      }).command,
    ).toBe(
      `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --dangerously-skip-permissions --resume ${ID}`,
    )
  })

  test('names the worktree, with short flags on a narrow terminal', () => {
    const worktree = { name: 'wtJ', recordCleared: true }
    expect(
      buildResumeHint({
        sessionId: ID,
        worktree,
        launchFlags: '--dangerously-skip-permissions',
        columns: 140,
      }),
    ).toEqual({
      advice: [],
      command: `claude --dangerously-skip-permissions --worktree "wtJ" --resume ${ID}`,
    })
    expect(
      buildResumeHint({ sessionId: ID, worktree, columns: 62 }).command,
    ).toBe(`claude -w "wtJ" -r ${ID}`)
  })

  test('explains how to resume when the worktree cannot be named', () => {
    const advice = [
      'This session ran in a worktree',
      'In its folder, run the command below to resume in it',
      'To find that folder, try git worktree list',
    ]
    const command = `claude --resume ${ID}`
    expect(
      buildResumeHint({
        sessionId: ID,
        worktree: { name: 'wtJ', recordCleared: true },
        columns: 40,
      }),
    ).toEqual({ advice, command })
    expect(
      buildResumeHint({
        sessionId: ID,
        worktree: { name: '-x', recordCleared: true },
        columns: 200,
      }),
    ).toEqual({ advice, command })
    expect(
      buildResumeHint({
        sessionId: ID,
        worktree: { name: '../x', recordCleared: false },
        columns: 200,
      }),
    ).toEqual({ advice: [], command })
  })
})

describe('getResumeHintLaunchFlags', () => {
  const { options } = new Command()
    .option('--dangerously-skip-permissions', '')
    .option('-p, --print', '')
    .option('--model <model>', '')
    .option('--add-dir <directories...>', '')
    .option('-d, --debug [filter]', '')
    .option('-r, --resume [value]', '')
    .option('-c, --continue', '')
    .option('-w, --worktree [name]', '')
    .option('-n, --name <name>', '')
    .option('--agent-id <id>', '')
    .option('--settings <file>', '')
  const flags = (...argv: string[]) => getResumeHintLaunchFlags(options, argv)

  test('keeps flags and their arguments, skipping the prompt', () => {
    expect(
      flags('--dangerously-skip-permissions', '--model', 'opus', 'hello'),
    ).toBe('--dangerously-skip-permissions --model opus')
    expect(flags('--add-dir', 'a', 'b', '-d')).toBe('--add-dir a b -d')
    expect(flags('--model=opus')).toBe('--model=opus')
    expect(flags()).toBe('')
  })

  test('skips flags that select or name the session', () => {
    expect(
      flags('--resume', 'abc', '-c', '-w', 'wt', '-n', 'title', '-d'),
    ).toBe('-d')
  })

  test('stops at --', () => {
    expect(flags('-d', '--', '--model', 'opus')).toBe('-d')
  })

  test('gives up on anything it cannot replay safely', () => {
    expect(flags('--dangerously-skip-permissions', '--unknown')).toBe('')
    expect(flags('--model')).toBe('')
    expect(flags('--model', 'a b')).toBe('')
    expect(flags('--model', '$(id)')).toBe('')
    expect(flags('--settings', '/dev/stdin')).toBe('')
    expect(flags('--settings=/proc/self/fd/3')).toBe('')
    expect(flags('--agent-id', 'x')).toBe('')
  })
})
