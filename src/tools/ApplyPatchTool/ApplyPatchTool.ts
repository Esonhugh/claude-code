import type { StructuredPatchHunk } from 'diff'
import isPlainObject from 'lodash-es/isPlainObject.js'
import { dirname } from 'path'
import { z } from 'zod/v4'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchFromContents } from '../../utils/diff.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { PatchParseError } from './parser.js'
import { type PlannedFile, planPatch, touchedPaths } from './plan.js'
import { APPLY_PATCH_DESCRIPTION, APPLY_PATCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, userFacingName } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    input: z.string().describe('The entire contents of the apply_patch command'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    files: z.array(
      z.object({
        type: z.enum(['add', 'update', 'delete']),
        filePath: z.string(),
        movePath: z.string().optional(),
        originalFile: z.string(),
        structuredPatch: z.array(z.custom<StructuredPatchHunk>()),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ApplyPatchOutput = z.infer<OutputSchema>

function notifyEditors(absolutePath: string, original: string | null, updated: string | null): void {
  const lspManager = getLspServerManager()
  if (lspManager && updated !== null) {
    clearDeliveredDiagnosticsForFile(`file://${absolutePath}`)
    for (const [action, run] of [
      ['change', () => lspManager.changeFile(absolutePath, updated)],
      ['save', () => lspManager.saveFile(absolutePath)],
    ] as const) {
      run().catch((err: Error) => {
        logForDebugging(`LSP: Failed to notify server of file ${action} for ${absolutePath}: ${err.message}`)
        logError(err)
      })
    }
  }
  notifyVscodeFileUpdated(absolutePath, original, updated)
}

export const ApplyPatchTool = buildTool({
  name: APPLY_PATCH_TOOL_NAME,
  searchHint: 'add, update, move or delete files with one patch',
  maxResultSizeChars: 100_000,
  strict: true,
  isEnabled() {
    // GPT models are trained on this tool; Claude keeps Edit/Write.
    return getAPIProvider() === 'openai'
  },
  async description() {
    return 'Add, update, move or delete files with one patch.'
  },
  async prompt() {
    return APPLY_PATCH_DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Patching ${summary}` : 'Patching files'
  },
  renderToolUseMessage,
  renderToolResultMessage,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  coerceInput(input) {
    if (!isPlainObject(input)) return null
    const next = { ...(input as Record<string, unknown>) }
    if (typeof next.input === 'string' || typeof next.patch !== 'string') return null
    next.input = next.patch
    delete next.patch
    return { input: next, resultNote: 'Note: `patch` was read as `input`.' }
  },
  // Permission hooks see the whole patch; give them the first touched file
  // and every touched file in file_paths.
  backfillObservableInput(input) {
    if (typeof input.input !== 'string') return
    let paths: string[]
    try {
      paths = touchedPaths(input.input)
    } catch {
      return
    }
    input.file_path = paths[0]
    input.file_paths = paths
  },
  async preparePermissionMatcher({ input }) {
    let paths: string[] = []
    try {
      paths = touchedPaths(input)
    } catch {
      // An unparsable patch touches no files, so no pattern matches it.
    }
    return pattern => paths.some(p => matchWildcardPattern(pattern, p))
  },
  toAutoClassifierInput(input) {
    return input.input
  },
  extractSearchText() {
    return ''
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    let paths: string[]
    try {
      paths = touchedPaths(input.input)
    } catch {
      // validateInput reports the parse error.
      return { behavior: 'allow', updatedInput: input }
    }
    const permissionContext = context.getAppState().toolPermissionContext
    // Each file goes through the same rules, modes and safety checks as Edit.
    for (const file_path of paths) {
      const decision = checkWritePermissionForTool(
        FileEditTool,
        { file_path, old_string: '', new_string: '' },
        permissionContext,
      )
      if (decision.behavior !== 'allow') return decision
    }
    return { behavior: 'allow', updatedInput: input }
  },
  async validateInput({ input }, toolUseContext: ToolUseContext) {
    let planned: PlannedFile[]
    try {
      planned = planPatch(input)
    } catch (e) {
      if (e instanceof PatchParseError) return { result: false, message: e.message, errorCode: 1 }
      throw e
    }
    const permissionContext = toolUseContext.getAppState().toolPermissionContext
    for (const file of planned) {
      for (const p of [file.absolutePath, file.absoluteMovePath]) {
        if (p && matchingRuleForInput(p, permissionContext, 'edit', 'deny') !== null) {
          return { result: false, message: `${p} is in a directory that is denied by your permission settings.`, errorCode: 2 }
        }
      }
      if (file.updated === null) continue
      const target = file.absoluteMovePath ?? file.absolutePath
      const secretError = checkTeamMemSecrets(target, file.updated)
      if (secretError) return { result: false, message: secretError, errorCode: 3 }
      const settingsError = validateInputForSettingsFileEdit(target, file.original, () => file.updated!)
      if (settingsError) return settingsError
    }
    return { result: true }
  },
  async call({ input }, context, _, parentMessage) {
    const { readFileState, updateFileHistoryState } = context
    const fs = getFsImplementation()
    // Directories and history backups first: these awaits must not run between
    // reading the files and writing them.
    for (const p of touchedPaths(input)) {
      await diagnosticTracker.beforeFileEdited(p)
      await fs.mkdir(dirname(p))
      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(updateFileHistoryState, p, parentMessage.uuid)
      }
    }

    let planned: PlannedFile[]
    try {
      planned = planPatch(input)
    } catch (e) {
      // The files changed between validation and now.
      if (e instanceof PatchParseError) throw new Error(e.message)
      throw e
    }

    const files: ApplyPatchOutput['files'] = []
    for (const file of planned) {
      const { op, absolutePath, absoluteMovePath, original, updated } = file
      if (updated === null) {
        // eslint-disable-next-line custom-rules/no-sync-fs
        fs.unlinkSync(absolutePath)
        readFileState.delete(absolutePath)
        notifyEditors(absolutePath, original, null)
        countLinesChanged(getPatchFromContents({ filePath: op.path, oldContent: original, newContent: '' }))
        files.push({ type: 'delete', filePath: op.path, originalFile: original, structuredPatch: [] })
        logFileOperation({ operation: 'write', tool: 'FileWriteTool', filePath: absolutePath, type: 'update' })
        continue
      }
      const target = absoluteMovePath ?? absolutePath
      writeTextContent(target, updated, file.encoding, file.lineEndings)
      if (absoluteMovePath) {
        // eslint-disable-next-line custom-rules/no-sync-fs
        fs.unlinkSync(absolutePath)
        readFileState.delete(absolutePath)
      }
      readFileState.set(target, {
        content: updated,
        timestamp: getFileModificationTime(target),
        offset: undefined,
        limit: undefined,
      })
      notifyEditors(target, op.type === 'add' ? null : original, updated)
      const structuredPatch = getPatchFromContents({ filePath: op.path, oldContent: original, newContent: updated })
      countLinesChanged(structuredPatch)
      logFileOperation({
        operation: op.type === 'add' ? 'write' : 'edit',
        tool: op.type === 'add' ? 'FileWriteTool' : 'FileEditTool',
        filePath: target,
        ...(op.type === 'add' && { type: 'create' as const }),
      })
      files.push({
        type: op.type === 'add' ? 'add' : 'update',
        filePath: op.path,
        ...(op.type === 'update' && op.movePath ? { movePath: op.movePath } : {}),
        originalFile: original,
        structuredPatch,
      })
    }
    return { data: { files } }
  },
  mapToolResultToToolResultBlockParam({ files }, toolUseID) {
    const letter = { add: 'A', update: 'M', delete: 'D' } as const
    const lines = files.map(f => `${letter[f.type]} ${f.movePath ?? f.filePath}`)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Success. Updated the following files:\n${lines.join('\n')}`,
    }
  },
} satisfies ToolDef<InputSchema, ApplyPatchOutput>)

