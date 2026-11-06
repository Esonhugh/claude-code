import { type ChildProcess, spawn } from 'child_process'
import { isInBundledMode } from '../../utils/bundledMode.js'

export type SpawnSessionOptions = {
  sessionId: string
  cwd: string
  permissionMode?: string
  model?: string
  /** `--effort` (low, medium, high, xhigh, max). */
  effort?: string
  /** Continue this existing transcript (its id becomes the session id). */
  resume?: boolean
  /** `plugin:<name>@<marketplace>` entries passed as `--channels`. */
  channels?: string[]
  /** `--settings` JSON (claude web's per-session plugins, MCP servers and hooks). */
  settings?: string
  /** `--system-prompt` / `--append-system-prompt` (a project's coordinator). */
  systemPrompt?: string
  appendSystemPrompt?: string
  /** Extra environment for the child, such as CLAUDE_CODE_COORDINATOR_MODE. */
  env?: Record<string, string>
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
  constructor(
    private options: {
      includePartialMessages?: boolean
      /** Let the client switch to bypassPermissions later (claude web). */
      allowBypassPermissions?: boolean
      /** Extra directories every session's tools may use (`--add-dir`). */
      addDirs?: string[]
      /** Echo queued prompts, such as teammate messages (`--replay-user-messages`). */
      replayUserMessages?: boolean
      /** Hook outcomes (`--include-hook-events`), for a hook that blocked or failed. */
      includeHookEvents?: boolean
      /** Keep file checkpoints so rewind_files can restore them, as the REPL does. */
      fileCheckpointing?: boolean
    } = {},
  ) {}

  spawn({
    sessionId,
    cwd,
    permissionMode,
    model,
    effort,
    resume,
    channels,
    settings,
    systemPrompt,
    appendSystemPrompt,
    env: extraEnv,
  }: SpawnSessionOptions): ChildProcess {
    const [command, ...entry] = isInBundledMode()
      ? [process.execPath]
      : [process.execPath, process.argv[1]!]
    const env = { ...process.env, ...extraEnv }
    // Let the child classify itself as a headless (sdk-cli) entrypoint.
    delete env.CLAUDE_CODE_ENTRYPOINT
    if (this.options.fileCheckpointing) env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
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
        resume ? '--resume' : '--session-id',
        sessionId,
        ...(permissionMode ? ['--permission-mode', permissionMode] : []),
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        ...(channels?.length ? ['--channels', ...channels] : []),
        ...(settings ? ['--settings', settings] : []),
        ...(systemPrompt ? ['--system-prompt', systemPrompt] : []),
        ...(appendSystemPrompt ? ['--append-system-prompt', appendSystemPrompt] : []),
        ...(this.options.includePartialMessages
          ? ['--include-partial-messages']
          : []),
        ...(this.options.allowBypassPermissions
          ? ['--allow-dangerously-skip-permissions']
          : []),
        ...(this.options.addDirs ?? []).flatMap(dir => ['--add-dir', dir]),
        ...(this.options.replayUserMessages ? ['--replay-user-messages'] : []),
        ...(this.options.includeHookEvents ? ['--include-hook-events'] : []),
      ],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  }
}
