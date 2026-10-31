import { expect, test } from 'bun:test'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileWriteTool } from './FileWriteTool.js'

const SUFFIX = ' (file state is current in your context — no need to Read it back)'

// Official 2.1.311 Write/Edit results tell the model the written state is current.
test('Write and Edit results carry the read-back suffix unless the user modified the change', () => {
  const write = (type: 'create' | 'update') =>
    FileWriteTool.mapToolResultToToolResultBlockParam({ type, filePath: '/w/a.txt', content: 'x', structuredPatch: [], originalFile: null, userModified: false }, 't').content
  expect(write('create')).toBe(`File created successfully at: /w/a.txt${SUFFIX}`)
  expect(write('update')).toBe(`The file /w/a.txt has been updated successfully.${SUFFIX}`)
  const edit = (userModified: boolean, replaceAll: boolean) =>
    FileEditTool.mapToolResultToToolResultBlockParam({ filePath: '/w/a.txt', userModified, replaceAll } as never, 't').content
  expect(edit(false, false)).toBe(`The file /w/a.txt has been updated successfully.${SUFFIX}`)
  expect(edit(false, true)).toBe(`The file /w/a.txt has been updated. All occurrences were successfully replaced.${SUFFIX}`)
  expect(edit(true, false)).toBe('The file /w/a.txt has been updated successfully.  The user modified your proposed changes before accepting them. .')
})
