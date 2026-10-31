import {
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
} from '../history.js'
import instances from '../ink/instances.js'
import type { Message } from '../types/message.js'
import type { PastedContent } from './config.js'
import { classifyGuiEditor, getExternalEditor } from './editor.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { getFsImplementation } from './fsOperations.js'
import { toIDEDisplayName } from './ide.js'
import { getAssistantMessageText } from './messages.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'
import { generateTempFilePath } from './tempfile.js'

// Map of editor command overrides (e.g., to add wait flags)
const EDITOR_OVERRIDES: Record<string, string> = {
  code: 'code -w', // VS Code: wait for file to be closed
  subl: 'subl --wait', // Sublime Text: wait for file to be closed
}

function isGuiEditor(editor: string): boolean {
  return classifyGuiEditor(editor) !== undefined
}

export type EditorResult = {
  content: string | null
  error?: string
}

// sync IO: called from sync context (React components, sync command handlers)
export function editFileInEditor(filePath: string): EditorResult {
  const fs = getFsImplementation()
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    throw new Error('Ink instance not found - cannot pause rendering')
  }

  const editor = getExternalEditor()
  if (!editor) {
    return { content: null }
  }

  try {
    fs.statSync(filePath)
  } catch {
    return { content: null }
  }

  const useAlternateScreen = !isGuiEditor(editor)

  if (useAlternateScreen) {
    // Terminal editors (vi, nano, etc.) take over the terminal. Delegate to
    // Ink's alt-screen-aware handoff so fullscreen mode (where <AlternateScreen>
    // already entered alt screen) doesn't get knocked back to the main buffer
    // by a hardcoded ?1049l. enterAlternateScreen() internally calls pause()
    // and suspendStdin(); exitAlternateScreen() undoes both and resets frame
    // state so the next render writes from scratch.
    inkInstance.enterAlternateScreen()
  } else {
    // GUI editors (code, subl, etc.) open in a separate window — just pause
    // Ink and release stdin while they're open.
    inkInstance.pause()
    inkInstance.suspendStdin()
  }

  try {
    // Use override command if available, otherwise use the editor as-is
    const editorCommand = EDITOR_OVERRIDES[editor] ?? editor
    execSync_DEPRECATED(`${editorCommand} "${filePath}"`, {
      stdio: 'inherit',
    })

    // Read the edited content
    const editedContent = fs.readFileSync(filePath, { encoding: 'utf-8' })
    return { content: editedContent }
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status
      if (status !== 0) {
        const editorName = toIDEDisplayName(editor)
        return {
          content: null,
          error: `${editorName} exited with code ${status}`,
        }
      }
    }
    return { content: null }
  } finally {
    if (useAlternateScreen) {
      inkInstance.exitAlternateScreen()
    } else {
      inkInstance.resumeStdin()
      inkInstance.resume()
    }
  }
}

/**
 * Re-collapse expanded pasted text by finding content that matches
 * pastedContents and replacing it with references.
 */
function recollapsePastedContent(
  editedPrompt: string,
  originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let collapsed = editedPrompt

  // Find pasted content in the edited text and re-collapse it
  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'text') {
      const pasteId = parseInt(id)
      const contentStr = content.content

      // Check if this exact content exists in the edited prompt
      const contentIndex = collapsed.indexOf(contentStr)
      if (contentIndex !== -1) {
        // Replace with reference
        const numLines = getPastedTextRefNumLines(contentStr)
        const ref = formatPastedTextRef(pasteId, numLines)
        collapsed =
          collapsed.slice(0, contentIndex) +
          ref +
          collapsed.slice(contentIndex + contentStr.length)
      }
    }
  }

  return collapsed
}

const CONTEXT_MAX_LINES = 50
const CONTEXT_MAX_MESSAGES = 8
const CONTEXT_MAX_BYTES = 65536
const REPLY_MARKER =
  '# ─── Write your reply below this line ──────────────────────────'

/**
 * Claude's text since the last human prompt (2.1.311 externalEditorContext):
 * up to 8 assistant messages and 64 KB, oldest first.
 */
export function getLastResponseText(messages: Message[]): string | undefined {
  const texts: string[] = []
  let bytes = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') {
      const text = getAssistantMessageText(message)?.trim()
      if (!text) continue
      const size = Buffer.byteLength(text, 'utf8')
      if (
        texts.length >= CONTEXT_MAX_MESSAGES ||
        (texts.length > 0 && bytes + size > CONTEXT_MAX_BYTES)
      ) {
        break
      }
      texts.push(text)
      bytes += size
    } else if (message.type === 'user') {
      const content = message.message.content
      if (
        typeof content !== 'string' &&
        content.some(block => block.type === 'tool_result')
      ) {
        continue
      }
      if (message.isMeta) continue
      break
    }
  }
  return texts.length > 0 ? texts.reverse().join('\n\n') : undefined
}

function formatContextHeader(context: string): string {
  let lines = context.split('\n')
  if (lines.length > CONTEXT_MAX_LINES) {
    lines = lines.slice(-CONTEXT_MAX_LINES)
    lines.unshift('… (earlier output truncated)')
  }
  return (
    "# ─── Claude's last response (for reference; removed on save) ───\n" +
    `${lines.map(line => (line ? `# ${line}` : '#')).join('\n')}\n` +
    `${REPLY_MARKER}\n\n`
  )
}

function stripContextHeader(content: string): string {
  const index = content.indexOf(REPLY_MARKER)
  if (index === -1) return content
  return content
    .slice(index + REPLY_MARKER.length)
    .replace(/^\r?\n\r?\n?/, '')
}

// sync IO: called from sync context (React components, sync command handlers)
export function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
  context?: string,
): EditorResult {
  const fs = getFsImplementation()
  const tempFile = generateTempFilePath()

  try {
    // Expand any pasted text references before editing
    const expandedPrompt = pastedContents
      ? expandPastedTextRefs(currentPrompt, pastedContents)
      : currentPrompt

    // Write expanded prompt to temp file
    const header = context ? formatContextHeader(context) : ''
    writeFileSync_DEPRECATED(tempFile, header + expandedPrompt, {
      encoding: 'utf-8',
      flush: true,
    })

    // Delegate to editFileInEditor
    const result = editFileInEditor(tempFile)

    if (result.content === null) {
      return result
    }

    // Trim a single trailing newline if present (common editor behavior)
    let finalContent = context
      ? stripContextHeader(result.content)
      : result.content
    if (finalContent.endsWith('\n') && !finalContent.endsWith('\n\n')) {
      finalContent = finalContent.slice(0, -1)
    }

    // Re-collapse pasted content if it wasn't edited
    if (pastedContents) {
      finalContent = recollapsePastedContent(
        finalContent,
        currentPrompt,
        pastedContents,
      )
    }

    return { content: finalContent }
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}
