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
import { expandPath } from '../../utils/path.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import type { PermissionRule } from '../../types/permissions.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { createPermissionRequestMessage, getAskRuleForTool, getDenyRuleForTool, toolAlwaysAllowedRule } from '../../utils/permissions/permissions.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { type PatchOperation, PatchParseError, parsePatch } from './parser.js'
import { type PatchPlan, planPatch, touchedPaths } from './plan.js'
import { APPLY_PATCH_DESCRIPTION, APPLY_PATCH_TOOL_NAME } from './prompt.js'
import { getToolUseSummary, renderToolResultMessage, renderToolUseMessage, userFacingName } from './UI.js'

// Not strict: the transcript and the tool row parse the input after
// backfillObservableInput has added file_path and file_paths to it.
const inputSchema = lazySchema(() =>
  z.object({
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
    // Set when a file did not apply: the files before it stay written.
    failure: z
      .object({
        type: z.enum(['add', 'update', 'delete']),
        filePath: z.string(),
        message: z.string(),
        notAttempted: z.array(z.string()),
      })
      .optional(),
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
    let ops: PatchOperation[]
    try {
      ops = parsePatch(input.input)
    } catch {
      // validateInput reports the parse error.
      return { behavior: 'allow', updatedInput: input }
    }
    const permissionContext = context.getAppState().toolPermissionContext
    // Each file goes through the same rules, modes and safety checks as the
    // tool Claude would use for it: Write for a new file, Edit otherwise. That
    // includes whole-tool rules such as a bare `Edit` allow, which the
    // permission pipeline only matches against apply_patch's own name.
    const files = ops.flatMap(op => [
      { file_path: expandPath(op.path), tool: op.type === 'add' ? FileWriteTool : FileEditTool },
      ...(op.type === 'update' && op.movePath ? [{ file_path: expandPath(op.movePath), tool: FileWriteTool }] : []),
    ])
    let allowRule: PermissionRule | undefined
    for (const { file_path, tool } of files) {
      const denyRule = getDenyRuleForTool(permissionContext, tool)
      if (denyRule) {
        return { behavior: 'deny', decisionReason: { type: 'rule', rule: denyRule }, message: `Permission to use ${tool.name} has been denied.` }
      }
      const decision = checkWritePermissionForTool(
        FileEditTool,
        { file_path, old_string: '', new_string: '' },
        permissionContext,
      )
      if (decision.behavior === 'deny') return decision
      const reason = decision.decisionReason
      if (decision.behavior === 'ask' && (reason?.type === 'safetyCheck' || (reason?.type === 'rule' && reason.rule.ruleBehavior === 'ask'))) {
        return decision
      }
      const askRule = getAskRuleForTool(permissionContext, tool)
      if (askRule) {
        return { behavior: 'ask', decisionReason: { type: 'rule', rule: askRule }, message: createPermissionRequestMessage(APPLY_PATCH_TOOL_NAME) }
      }
      if (decision.behavior === 'allow') continue
      const wholeToolAllow = toolAlwaysAllowedRule(permissionContext, tool)
      if (!wholeToolAllow) return decision
      allowRule ??= wholeToolAllow
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      ...(allowRule && { decisionReason: { type: 'rule' as const, rule: allowRule } }),
    }
  },
  async validateInput({ input }, toolUseContext: ToolUseContext) {
    let plan: PatchPlan
    try {
      plan = planPatch(input)
    } catch (e) {
      if (e instanceof PatchParseError) return { result: false, message: e.message, errorCode: 1 }
      throw e
    }
    // Nothing would apply; a later failure still lets the files before it through.
    if (plan.failure && plan.planned.length === 0) return { result: false, message: plan.failure.message, errorCode: 1 }
    const permissionContext = toolUseContext.getAppState().toolPermissionContext
    for (const p of touchedPaths(input)) {
      if (matchingRuleForInput(p, permissionContext, 'edit', 'deny') !== null) {
        return { result: false, message: `${p} is in a directory that is denied by your permission settings.`, errorCode: 2 }
      }
    }
    for (const file of plan.planned) {
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
    // History backups first: these awaits must not run between reading the
    // files and writing them.
    for (const p of touchedPaths(input)) {
      await diagnosticTracker.beforeFileEdited(p)
      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(updateFileHistoryState, p, parentMessage.uuid)
      }
    }

    let plan: PatchPlan
    try {
      plan = planPatch(input)
    } catch (e) {
      if (e instanceof PatchParseError) throw new Error(e.message)
      throw e
    }
    const { planned, failure } = plan
    // The files changed between validation and now.
    if (failure && planned.length === 0) throw new Error(failure.message)

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
      fs.mkdirSync(dirname(target))
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
    if (!failure) return { data: { files } }
    const ops = parsePatch(input)
    const failedIndex = ops.findIndex(op => op.path === failure.path)
    const failedOp = ops[failedIndex]!
    return {
      data: {
        files,
        failure: {
          type: failedOp.type,
          filePath: failure.path,
          message: failure.message,
          notAttempted: ops.slice(failedIndex + 1).map(op => op.path),
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam({ files, failure }, toolUseID) {
    const letter = { add: 'A', update: 'M', delete: 'D' } as const
    const lines = files.map(f => `${letter[f.type]} ${f.movePath ?? f.filePath}`).join('\n')
    const content = failure
      ? [
          `Failed to apply ${failure.filePath}: ${failure.message}`,
          `Applied before the failure (these changes are kept):\n${lines}`,
          ...(failure.notAttempted.length ? [`Not attempted:\n${failure.notAttempted.join('\n')}`] : []),
        ].join('\n\n')
      : `Success. Updated the following files:\n${lines}`
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
} satisfies ToolDef<InputSchema, ApplyPatchOutput>)

