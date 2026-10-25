import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = 'Write a file to the local filesystem.'

export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already ${FILE_READ_TOOL_NAME}. Overwriting an existing file you haven't ${FILE_READ_TOOL_NAME} will fail. For partial changes, use Edit instead.`
}
