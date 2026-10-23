import { type ChildProcess, spawn } from 'child_process'
import { isInBundledMode } from '../../utils/bundledMode.js'

export type SpawnSessionOptions = {
  sessionId: string
  cwd: string
  permissionMode?: string
}

/**
 * Runs each session as a local `claude -p` stream-json child of this same
 * binary, with the full privileges of the user running `claude server`
 * (no sandbox — anyone holding the auth token gets that access).
 *
 * `--permission-prompt-tool stdio` makes the child emit `can_use_tool`
 * control requests on stdout and wait for the `control_response` on stdin,
 * which the server relays to and from the connected client.
 */
export class DangerousBackend {
  spawn({ sessionId, cwd, permissionMode }: SpawnSessionOptions): ChildProcess {
    const [command, ...entry] = isInBundledMode()
      ? [process.execPath]
      : [process.execPath, process.argv[1]!]
    const env = { ...process.env }
    // Let the child classify itself as a headless (sdk-cli) entrypoint.
    delete env.CLAUDE_CODE_ENTRYPOINT
    return spawn(
      command,
      [
        ...entry,
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-prompt-tool',
        'stdio',
        '--session-id',
        sessionId,
        ...(permissionMode ? ['--permission-mode', permissionMode] : []),
      ],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  }
}
