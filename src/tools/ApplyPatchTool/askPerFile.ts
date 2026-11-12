import isEqual from 'lodash-es/isEqual.js'
import type { Tool, Tools } from '../../Tool.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { findToolByName } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { PatchParseError } from './parser.js'
import { patchHookSteps, type PlannedFile, planPatch } from './plan.js'
import { APPLY_PATCH_TOOL_NAME } from './prompt.js'

// An SDK host (canUseTool, --permission-prompt-tool stdio, the web UI) knows
// Edit and Write, not patches. So when a patch needs approval it is asked one
// file at a time, as the Edit or Write call that makes the same change: a new
// file is a Write, a changed file an Edit of its whole content, a deleted file
// an Edit to empty, a move a Write of the new path plus a deleting Edit.
// Like Codex, files apply in order and a denied file stops the patch there:
// the files before it are applied and the model is told which were not.

type Ask = (tool: Tool, input: Record<string, unknown>) => Promise<PermissionDecision>

type FinalFile = { path: string; movePath: string | null; original: string | null; updated: string | null }

const lines = (content: string) => {
  const l = content.split('\n')
  if (l[l.length - 1] === '') l.pop()
  return l
}
const withNewline = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`)

/** A patch that turns each file's original content into its final content. */
function renderPatch(files: FinalFile[]): string {
  const sections = files.map(({ path, movePath, original, updated }) => {
    if (updated === null) return `*** Delete File: ${path}`
    if (original === null) return [`*** Add File: ${path}`, ...lines(updated).map(l => `+${l}`)].join('\n')
    const bom = original.startsWith('﻿') ? '﻿' : ''
    const before = original.slice(bom.length)
    const after = updated.startsWith(bom) ? updated.slice(bom.length) : updated
    const hunk = before === after ? [] : [...lines(before).map(l => `-${l}`), ...lines(after).map(l => `+${l}`)]
    return [`*** Update File: ${path}`, ...(movePath ? [`*** Move to: ${movePath}`] : []), ...hunk].join('\n')
  })
  return ['*** Begin Patch', ...sections, '*** End Patch'].join('\n')
}

function rendersTo(patch: string, files: FinalFile[]): boolean {
  try {
    const { planned, failure } = planPatch(patch)
    return (
      !failure &&
      planned.length === files.length &&
      planned.every((f, i) => (f.updated === null ? files[i]!.updated === null : files[i]!.updated !== null && withNewline(f.updated) === withNewline(files[i]!.updated!)))
    )
  } catch (e) {
    if (e instanceof PatchParseError) return false
    throw e
  }
}

/**
 * Asks for an apply_patch call file by file through `ask`. Returns null when
 * the patch cannot be split (malformed, or Edit/Write are not available), so
 * the caller asks for the whole patch as before.
 */
export async function askApplyPatchPerFile(
  input: Record<string, unknown>,
  tools: Tools,
  ask: Ask,
): Promise<PermissionDecision | null> {
  const editTool = findToolByName(tools, FILE_EDIT_TOOL_NAME)
  const writeTool = findToolByName(tools, FILE_WRITE_TOOL_NAME)
  if (typeof input.input !== 'string' || !editTool || !writeTool) return null
  let planned: PlannedFile[]
  try {
    // A file that does not apply is not asked about; the tool reports it.
    planned = planPatch(input.input).planned
  } catch {
    return null
  }
  if (planned.length === 0) return null

  const approved: FinalFile[] = []
  let changed = false
  for (const [index, f] of planned.entries()) {
    const file: FinalFile = {
      path: f.op.path,
      movePath: f.op.type === 'update' ? f.op.movePath : null,
      original: f.op.type === 'add' ? null : f.original,
      updated: f.updated,
    }
    const steps = patchHookSteps([{ path: f.absolutePath, movePath: f.absoluteMovePath, original: file.original, updated: file.updated }])
    let denial: PermissionDecision | null = null
    for (const step of steps) {
      const decision = await ask(step.toolName === FILE_EDIT_TOOL_NAME ? editTool : writeTool, step.input)
      if (decision.behavior !== 'allow') {
        denial = decision
        break
      }
      const answered = decision.updatedInput
      if (!answered || isEqual(answered, step.input)) continue
      // The host changed the call. Only the new content can be carried back
      // into the patch, and only for a file that is written.
      const content = step.toolName === FILE_WRITE_TOOL_NAME ? answered.content : answered.new_string
      const keepsShape =
        answered.file_path === step.input.file_path &&
        typeof content === 'string' &&
        file.updated !== null &&
        (step.toolName === FILE_WRITE_TOOL_NAME || !file.movePath)
      if (!keepsShape) {
        const message = `The permission handler changed ${step.toolName} for ${f.op.path} in a way apply_patch cannot apply; only the new file content can be changed.`
        denial = { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
        break
      }
      file.updated = content
      changed = true
    }
    if (denial) {
      if (index === 0) return denial
      const notAttempted = planned.slice(index + 1).map(p => p.op.path)
      return finish(approved, {
        acceptFeedback: [
          `Permission to change ${f.op.path} was denied${'message' in denial && denial.message ? `: ${denial.message}` : '.'}`,
          `${f.op.path}${notAttempted.length ? ` and the files after it (${notAttempted.join(', ')}) were` : ' was'} not changed. Only the files listed in the result were applied.`,
        ].join('\n'),
      })
    }
    approved.push(file)
  }
  if (!changed && approved.length === planned.length) return { behavior: 'allow', updatedInput: input }
  return finish(approved, {})

  function finish(files: FinalFile[], extra: { acceptFeedback?: string }): PermissionDecision {
    const patch = renderPatch(files)
    if (!rendersTo(patch, files)) {
      const message = `${APPLY_PATCH_TOOL_NAME} could not apply the change the permission handler approved. No files were changed.`
      return { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
    }
    return { behavior: 'allow', updatedInput: { input: patch }, userModified: changed, ...extra }
  }
}
