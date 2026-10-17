import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanMemoryFiles, formatMemoryManifest } from './memoryScan.js'
import type { MemoryType } from './memoryTypes.js'

// Official 2.1.292 helpers gu -> yke -> TKt: nested metadata wins,
// including invalid/null values; a missing nested key retains the legacy type.
const cases: { name: string; frontmatter: Record<string, unknown>; expected: MemoryType | undefined }[] = [
  { name: "legacy-user", frontmatter: {"type": "user"}, expected: "user" },
  { name: "nested-user", frontmatter: {"metadata": {"type": "user"}}, expected: "user" },
  { name: "legacy-feedback", frontmatter: {"type": "feedback"}, expected: "feedback" },
  { name: "nested-feedback", frontmatter: {"metadata": {"type": "feedback"}}, expected: "feedback" },
  { name: "legacy-project", frontmatter: {"type": "project"}, expected: "project" },
  { name: "nested-project", frontmatter: {"metadata": {"type": "project"}}, expected: "project" },
  { name: "legacy-reference", frontmatter: {"type": "reference"}, expected: "reference" },
  { name: "nested-reference", frontmatter: {"metadata": {"type": "reference"}}, expected: "reference" },
  { name: "nested-wins", frontmatter: {"type": "user", "metadata": {"type": "project"}}, expected: "project" },
  { name: "nested-invalid-shadows-legacy", frontmatter: {"type": "user", "metadata": {"type": "bogus"}}, expected: undefined },
  { name: "nested-null-shadows-legacy", frontmatter: {"type": "user", "metadata": {"type": null}}, expected: undefined },
  { name: "nested-number-shadows-legacy", frontmatter: {"type": "user", "metadata": {"type": 1}}, expected: undefined },
  { name: "nested-missing-keeps-legacy", frontmatter: {"type": "reference", "metadata": {"other": "value"}}, expected: "reference" },
  { name: "null-metadata", frontmatter: {"type": "user", "metadata": null}, expected: "user" },
  { name: "array-metadata", frontmatter: {"type": "user", "metadata": ["feedback"]}, expected: "user" },
  { name: "string-metadata", frontmatter: {"type": "user", "metadata": "feedback"}, expected: "user" },
  { name: "missing-type", frontmatter: {}, expected: undefined },
  { name: "unknown-type", frontmatter: {"type": "bogus"}, expected: undefined },
  { name: "empty-type", frontmatter: {"metadata": {"type": ""}}, expected: undefined },
]
async function withDirectory(run: (dir: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'memory-metadata-')))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
for (const { name, frontmatter, expected } of cases) {
  test('memory metadata type: ' + name, () => withDirectory(async dir => {
    const filename = name + '.md'
    const text = '---\n' + JSON.stringify({ description: 'retained description', ...frontmatter }) +
      '\n---\n# Body\ntype: project\n'
    await writeFile(join(dir, filename), text)
    const headers = await scanMemoryFiles(dir, new AbortController().signal)
    expect(headers).toHaveLength(1)
    expect(headers[0]!.type).toBe(expected)
    expect(headers[0]!.description).toBe('retained description')
    expect(await readFile(join(dir, filename), 'utf8')).toBe(text)
  }))
}
test('nested metadata preserves manifest text, ordering and MEMORY.md exclusion', () => withDirectory(async dir => {
  await mkdir(join(dir, 'nested'))
  await writeFile(join(dir, 'MEMORY.md'), '---\ntype: user\n---\nindex')
  await writeFile(join(dir, 'ignored.txt'), 'not a memory')
  await writeFile(join(dir, 'older.md'), '---\ntype: reference\ndescription: older note\n---\nbody')
  await writeFile(join(dir, 'nested/newer.md'), '---\nmetadata:\n  type: feedback\n  description: must not replace description\ndescription: newer note\n---\nbody')
  await utimes(join(dir, 'older.md'), 1700000000, 1700000000)
  await utimes(join(dir, 'nested/newer.md'), 1700000001, 1700000001)
  const headers = await scanMemoryFiles(dir, new AbortController().signal)
  expect(headers.map(header => header.filename)).toEqual(['nested/newer.md', 'older.md'])
  expect(formatMemoryManifest(headers)).toBe(
    '- [feedback] nested/newer.md (2023-11-14T22:13:21.000Z): newer note\n' +
    '- [reference] older.md (2023-11-14T22:13:20.000Z): older note',
  )
}))
