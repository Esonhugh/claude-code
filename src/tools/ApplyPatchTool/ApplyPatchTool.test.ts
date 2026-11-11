import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { ApplyPatchTool } from './ApplyPatchTool.js'
import { applyChunks, parsePatch, PatchParseError } from './parser.js'

function context(permissionContext = getEmptyToolPermissionContext()) {
  return {
    getAppState: () => ({ ...getDefaultAppState(), toolPermissionContext: permissionContext }),
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 1_000_000),
    updateFileHistoryState: () => {},
  }
}

function withDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-patch-test-'))
    try {
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('parses add, update with move and @@ hunks, and delete', () => {
  const ops = parsePatch(`*** Begin Patch
*** Add File: new.txt
+one
+two
*** Update File: a.py
*** Move to: b.py
@@ def f():
-    return 1
+    return 2
@@
 x = 1
+y = 2
*** End of File
*** Delete File: old.txt
*** End Patch`)
  assert.deepEqual(ops[0], { type: 'add', path: 'new.txt', content: 'one\ntwo\n' })
  assert.equal(ops[1]!.type, 'update')
  assert.deepEqual(ops[1], {
    type: 'update',
    path: 'a.py',
    movePath: 'b.py',
    chunks: [
      { changeContext: 'def f():', oldLines: ['    return 1'], newLines: ['    return 2'], isEndOfFile: false },
      { changeContext: null, oldLines: ['x = 1'], newLines: ['x = 1', 'y = 2'], isEndOfFile: true },
    ],
  })
  assert.deepEqual(ops[2], { type: 'delete', path: 'old.txt' })
})

test('accepts the heredoc shell form and rejects malformed patches', () => {
  assert.equal(parsePatch("apply_patch <<'EOF'\n*** Begin Patch\n*** Delete File: a\n*** End Patch\nEOF").length, 1)
  assert.throws(() => parsePatch('*** Update File: a\n-x\n'), PatchParseError)
  assert.throws(() => parsePatch('*** Begin Patch\n*** Add File: a\nno plus\n*** End Patch'), /must start with '\+'/)
  assert.throws(() => parsePatch('*** Begin Patch\n*** End Patch'), /no file operations/)
})

test('applies several hunks in one file, seeking @@ context and ignoring trailing whitespace', () => {
  const file = 'def a():\n    return 1\n\ndef b():\n    return 1  \n'
  const [op] = parsePatch(`*** Begin Patch
*** Update File: m.py
@@ def a():
-    return 1
+    return 10
@@ def b():
-    return 1
+    return 20
*** End Patch`)
  assert.equal(op!.type, 'update')
  assert.equal(
    applyChunks(file, op!.type === 'update' ? op!.chunks : [], 'm.py'),
    'def a():\n    return 10\n\ndef b():\n    return 20\n',
  )
  assert.throws(
    () => applyChunks('x\n', [{ changeContext: null, oldLines: ['missing'], newLines: [], isEndOfFile: false }], 'm.py'),
    /Failed to find expected lines in m.py/,
  )
})

test('applies a multi-file patch and records the new file state', withDir(async dir => {
  writeFileSync(join(dir, 'a.txt'), 'keep\nold\n')
  writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n')
  writeFileSync(join(dir, 'gone.txt'), 'bye\n')
  const input = `*** Begin Patch
*** Update File: ${join(dir, 'a.txt')}
 keep
-old
+new
*** Update File: ${join(dir, 'crlf.txt')}
*** Move to: ${join(dir, 'moved.txt')}
-two
+three
*** Add File: ${join(dir, 'sub/added.txt')}
+hello
*** Delete File: ${join(dir, 'gone.txt')}
*** End Patch`
  const ctx = context()
  assert.deepEqual(await ApplyPatchTool.validateInput!({ input }, ctx as never), { result: true })
  const result = await ApplyPatchTool.call({ input }, ctx as never, undefined as never, { uuid: 'u' } as never)

  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'keep\nnew\n')
  assert.equal(readFileSync(join(dir, 'moved.txt'), 'utf8'), 'one\r\nthree\r\n')
  assert.equal(existsSync(join(dir, 'crlf.txt')), false)
  assert.equal(readFileSync(join(dir, 'sub/added.txt'), 'utf8'), 'hello\n')
  assert.equal(existsSync(join(dir, 'gone.txt')), false)
  assert.equal(ctx.readFileState.get(join(dir, 'a.txt'))?.content, 'keep\nnew\n')
  assert.equal(
    ApplyPatchTool.mapToolResultToToolResultBlockParam(result.data, 't').content,
    `Success. Updated the following files:\nM ${join(dir, 'a.txt')}\nM ${join(dir, 'moved.txt')}\nA ${join(dir, 'sub/added.txt')}\nD ${join(dir, 'gone.txt')}`,
  )
}))

test('a file that does not apply as the first one fails validation with nothing changed', withDir(async dir => {
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  const input = `*** Begin Patch
*** Update File: ${join(dir, 'a.txt')}
-not there
+A
*** Update File: ${join(dir, 'b.txt')}
-b
+B
*** End Patch`
  const validation = await ApplyPatchTool.validateInput!({ input }, context() as never)
  assert.equal(validation.result, false)
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b\n')
  for (const bad of [
    `*** Begin Patch\n*** Add File: ${join(dir, 'a.txt')}\n+x\n*** End Patch`,
    `*** Begin Patch\n*** Delete File: ${join(dir, 'nope.txt')}\n*** End Patch`,
    `*** Begin Patch\n*** Delete File: ${join(dir, 'b.txt')}\n*** Delete File: ${join(dir, 'b.txt')}\n*** End Patch`,
  ]) {
    assert.equal((await ApplyPatchTool.validateInput!({ input: bad }, context() as never)).result, false)
  }
}))

test('applies files in order, keeps the ones before a failure and stops there', withDir(async dir => {
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  const input = `*** Begin Patch
*** Update File: ${join(dir, 'a.txt')}
-a
+A
*** Add File: ${join(dir, 'sub/new.txt')}
+n
*** Update File: ${join(dir, 'b.txt')}
-not there
+B
*** Add File: ${join(dir, 'later/c.txt')}
+c
*** End Patch`
  const ctx = context()
  assert.deepEqual(await ApplyPatchTool.validateInput!({ input }, ctx as never), { result: true })
  const result = await ApplyPatchTool.call({ input }, ctx as never, undefined as never, { uuid: 'u' } as never)

  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A\n')
  assert.equal(readFileSync(join(dir, 'sub/new.txt'), 'utf8'), 'n\n')
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b\n')
  assert.equal(existsSync(join(dir, 'later')), false)
  assert.deepEqual(result.data.files.map(f => f.type), ['update', 'add'])
  assert.equal(result.data.failure?.type, 'update')
  assert.equal(result.data.failure?.filePath, join(dir, 'b.txt'))
  assert.deepEqual(result.data.failure?.notAttempted, [join(dir, 'later/c.txt')])
  const content = ApplyPatchTool.mapToolResultToToolResultBlockParam(result.data, 't').content as string
  assert.match(content, new RegExp(`^Failed to apply ${join(dir, 'b.txt')}: Failed to find expected lines`))
  assert.ok(content.includes(`Applied before the failure (these changes are kept):\nM ${join(dir, 'a.txt')}\nA ${join(dir, 'sub/new.txt')}`))
  assert.ok(content.endsWith(`Not attempted:\n${join(dir, 'later/c.txt')}`))
}))

test('every touched path goes through the Edit permission rules', withDir(async dir => {
  const allowed = { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' as const, additionalWorkingDirectories: new Map([[dir, { path: dir, source: 'session' as const }]]) }
  const inside = `*** Begin Patch\n*** Add File: ${join(dir, 'x.txt')}\n+x\n*** End Patch`
  assert.equal((await ApplyPatchTool.checkPermissions({ input: inside }, context(allowed) as never)).behavior, 'allow')

  const denied = {
    ...allowed,
    alwaysDenyRules: { session: [`Edit(/${join(dir, 'secret')}/**)`] },
  }
  const mixed = `*** Begin Patch\n*** Add File: ${join(dir, 'x.txt')}\n+x\n*** Add File: ${join(dir, 'secret/y.txt')}\n+y\n*** End Patch`
  assert.equal((await ApplyPatchTool.checkPermissions({ input: mixed }, context(denied as never) as never)).behavior, 'deny')
  assert.equal((await ApplyPatchTool.validateInput!({ input: mixed }, context(denied as never) as never)).result, false)
  assert.equal(existsSync(join(dir, 'x.txt')), false)
}))

test('the input still parses after the observable backfill adds file paths', () => {
  const input: Record<string, unknown> = { input: '*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch' }
  ApplyPatchTool.backfillObservableInput!(input)
  assert.ok(Array.isArray(input.file_paths))
  assert.equal(ApplyPatchTool.inputSchema.safeParse(input).success, true)
})

test('only the OpenAI provider gets the tool', () => {
  const saved = process.env.CLAUDE_CODE_USE_OPENAI
  try {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    assert.equal(ApplyPatchTool.isEnabled(), false)
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    assert.equal(ApplyPatchTool.isEnabled(), true)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = saved
  }
})
