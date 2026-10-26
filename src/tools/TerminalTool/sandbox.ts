import { readdirSync, readFileSync } from 'node:fs'
import type { z } from 'zod/v4'
import { quote } from '../../utils/bash/shellQuote.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { resolveTerminalCommand } from '../../utils/shell/resolveDefaultShell.js'
import { whichSync } from '../../utils/which.js'
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'
import type { newSessionActionSchema } from './actionSchemas.js'

type NewSessionActionInput = z.infer<typeof newSessionActionSchema>

/**
 * Rewrites a new-session request to start its command inside the Bash
 * sandbox, or returns undefined when the command should run unsandboxed.
 * `command` and `args` are the resolved command the sandbox runs.
 */
export async function wrapNewSessionForSandbox(
  input: NewSessionActionInput,
): Promise<
  { open: NewSessionActionInput; command: string; args: string[] } | undefined
> {
  if (!SandboxManager.isSandboxingEnabled()) return undefined
  const resolved = resolveTerminalCommand({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  })
  const argv = [resolved.command, ...(input.args ?? resolved.args)]
  const command = quote(argv)
  if (
    !shouldUseSandbox({
      command,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    })
  ) {
    return undefined
  }
  // bwrap starts the command in a new session without a controlling
  // terminal, so the shell would get no job control and Ctrl-C would not
  // reach it. script gives it a PTY of its own inside the sandbox.
  const script = getPlatform() === 'linux' ? whichSync('script') : null
  const inner = script
    ? quote([script, '-qfec', command, '/dev/null'])
    : command
  return {
    open: {
      ...input,
      command: '/bin/sh',
      args: ['-c', await SandboxManager.wrapWithSandbox(inner, '/bin/sh')],
    },
    command: argv[0]!,
    args: argv.slice(1),
  }
}

/**
 * The inner script PTY is in another session, so resizing the outer PTY
 * does not signal it. Tell every script under the session's process to
 * re-read the window size.
 */
export function forwardResizeIntoSandbox(rootPid: number): void {
  if (getPlatform() !== 'linux') return
  const children = new Map<number, number[]>()
  const names = new Map<number, string>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    // pid (comm) state ppid ...; comm may contain spaces and parentheses.
    const end = stat.lastIndexOf(')')
    const pid = Number(entry)
    const ppid = Number(stat.slice(end + 2).split(' ')[1])
    names.set(pid, stat.slice(stat.indexOf('(') + 1, end))
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const queue = [rootPid]
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of children.get(pid) ?? []) {
      if (names.get(child) === 'script') {
        try {
          process.kill(child, 'SIGWINCH')
        } catch {
          // exited meanwhile
        }
      }
      queue.push(child)
    }
  }
}
