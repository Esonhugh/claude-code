import { getAPIProvider } from '../../utils/model/providers.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

// In its own file to avoid circular dependencies. Name and `input` parameter
// match the apply_patch tool GPT models are trained on.
export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

// Like Codex, GPT models edit files only through apply_patch unless
// openaiEditTools is "all".
export function isApplyPatchOnly(): boolean {
  return getAPIProvider() === 'openai' && getInitialSettings().openaiEditTools !== 'all'
}

export const APPLY_PATCH_DESCRIPTION = `Edit files with a patch. One call can add, update, move and delete several files, so put all related changes in one patch.

The patch format:
*** Begin Patch
*** Add File: path/to/new.py
+every line of the new file, prefixed with +
*** Update File: path/to/existing.py
*** Move to: path/to/renamed.py   (optional)
@@ def function_or_class_to_seek   (optional; a line that comes before the hunk)
 context line (prefixed with a space)
-removed line
+added line
*** Delete File: path/to/obsolete.py
*** End Patch

- Paths are relative to the working directory, or absolute.
- Give about 3 lines of unchanged context around each change, and use @@ lines when the context is not unique.
- Several hunks may follow one Update File header; start each with @@.
- Context and removed lines must match the file exactly; the whole patch fails without changing anything when one hunk does not match.`
