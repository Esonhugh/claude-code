import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { isAnt } from 'src/utils/userType.js'


export function getEditToolDescription(): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  const minimalUniquenessHint = isAnt()
    ? ` Use the smallest \`old_string\` that's clearly unique — usually 2-4 adjacent lines.`
    : ''
  return `Performs exact string replacement in a file.

- You must ${FILE_READ_TOOL_NAME} the file in this conversation before editing, or the call will fail.
- \`old_string\` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the ${FILE_READ_TOOL_NAME} line prefix (${prefixFormat}) before matching.${minimalUniquenessHint}
- \`replace_all: true\` replaces every occurrence instead.`
}
