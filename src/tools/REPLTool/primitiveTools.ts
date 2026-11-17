import type { Tool } from '../../Tool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'
import { getPlatform } from '../../utils/platform.js'
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'

let _primitiveTools: readonly Tool[] | undefined

/**
 * Primitive tools hidden from direct model use when REPL mode is on
 * (CODE_MODE_ONLY_TOOLS, REPL_PRIMITIVE_TOOL_NAMES) but still accessible
 * inside the REPL VM context.
 * Exported so display-side code (collapseReadSearch, renderers) can
 * classify/render virtual messages for these tools even when they're
 * absent from the filtered execution tools list.
 *
 * Lazy getter — the import chain collapseReadSearch.ts → primitiveTools.ts
 * → FileReadTool.tsx → ... loops back through the tool registry, so a
 * top-level const hits "Cannot access before initialization". Deferring
 * to call time avoids the TDZ.
 *
 * Referenced directly rather than via getAllBaseTools() because that
 * excludes Glob/Grep when hasEmbeddedSearchTools() is true.
 */
export function getReplPrimitiveTools(): readonly Tool[] {
  const tools = (_primitiveTools ??= [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
    NotebookEditTool,
  ])
  // Shell availability can change (PowerShell is a setting), so it is applied
  // on every call rather than cached, like official dr().
  const shells = isPowerShellToolEnabled() ? [getPowerShellTool()] : []
  if (shells.length === 0 && isBashAvailable()) return tools
  return [
    ...tools.filter(tool => tool !== BashTool || isBashAvailable()),
    ...shells,
  ]
}

/**
 * Bash needs Git Bash on Windows. setShellIfWindows() points SHELL at it
 * during startup, so an unset SHELL there means no Bash.
 */
function isBashAvailable(): boolean {
  return getPlatform() !== 'windows' || !!process.env.SHELL
}

function getPowerShellTool(): Tool {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../PowerShellTool/PowerShellTool.js') as typeof import('../PowerShellTool/PowerShellTool.js')).PowerShellTool
}
