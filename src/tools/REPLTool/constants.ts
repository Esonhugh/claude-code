import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { isAnt } from 'src/utils/userType.js'


export const REPL_TOOL_NAME = 'REPL'
export const POLL_TOOL_NAME = 'Poll'

/**
 * REPL mode is on when Code Mode is on (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1),
 * and default-on for ants in the interactive CLI (opt out with
 * CLAUDE_CODE_REPL=0). The legacy CLAUDE_REPL_MODE=1 also forces it on.
 *
 * SDK entrypoints (sdk-ts, sdk-py, sdk-cli) are NOT defaulted on — SDK
 * consumers script direct tool calls (Bash, Read, etc.) and REPL mode
 * hides those tools.
 */
export function isReplModeEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false
  if (isEnvTruthy(process.env.CLAUDE_REPL_MODE)) return true
  // Lazy: codeModeGate reaches session state whose import graph loops back
  // here (permissionSetup reads REPL_TOOL_NAME at module init).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if ((require('./codeModeGate.js') as typeof import('./codeModeGate.js')).isCodeModeEnabled()) return true
  return (
    isAnt() &&
    process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'
  )
}

/**
 * Tools removed from the tool pool when REPL is present: the model reaches
 * them only as functions inside a REPL script.
 */
export const CODE_MODE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
])

/**
 * Tools a REPL script can always call. Write and Edit stay in the tool pool
 * (other code looks them up there) but are not sent to the API.
 */
export const REPL_PRIMITIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CODE_MODE_ONLY_TOOLS,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
])
