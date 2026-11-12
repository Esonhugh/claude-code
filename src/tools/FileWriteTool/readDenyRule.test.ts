import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'

function context(deny: string[]) {
  return {
    getAppState: () => ({
      ...getDefaultAppState(),
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        alwaysDenyRules: { session: deny },
      },
    }),
    readFileState: new Map(),
    options: { mainLoopModel: "claude-sonnet-4-5" },
  } as never
}

test('Write and Edit refuse a file a Read deny rule covers, like official', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-deny-write-'))
  try {
    const env = join(dir, '.env')
    writeFileSync(env, 'K=1\n')
    const ctx = context([`Read(/${dir}/**/.env)`])
    expect(await FileWriteTool.validateInput({ file_path: env, content: 'K=2' }, ctx)).toMatchObject({
      result: false, errorCode: 13, deniedByPermissionRule: true,
      message: 'File is covered by a Read deny rule in your permission settings and cannot be written.',
    })
    expect(await FileWriteTool.validateInput({ file_path: join(dir, 'sub/.env'), content: 'x' }, ctx)).toMatchObject({
      result: false, errorCode: 13,
    })
    expect(await FileEditTool.validateInput({ file_path: env, old_string: 'K=1', new_string: 'K=2' }, ctx)).toMatchObject({
      result: false, errorCode: 13, deniedByPermissionRule: true,
      message: 'File is covered by a Read deny rule in your permission settings and cannot be edited.',
    })
    expect(await FileWriteTool.validateInput({ file_path: join(dir, 'ok.txt'), content: 'x' }, ctx)).toEqual({ result: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deny-rule refusals from validateInput are marked as permission denials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-deny-mark-'))
  try {
    const file = join(dir, 'locked.txt')
    expect(await FileReadTool.validateInput({ file_path: file }, context([`Read(/${file})`]))).toMatchObject({
      result: false, errorCode: 1, deniedByPermissionRule: true,
    })
    expect(await FileWriteTool.validateInput({ file_path: file, content: 'x' }, context([`Edit(/${file})`]))).toMatchObject({
      result: false, errorCode: 1, deniedByPermissionRule: true,
    })
    expect(await FileEditTool.validateInput({ file_path: file, old_string: 'a', new_string: 'b' }, context([`Edit(/${file})`]))).toMatchObject({
      result: false, errorCode: 2, deniedByPermissionRule: true,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
