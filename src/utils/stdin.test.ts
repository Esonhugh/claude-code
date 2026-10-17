import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSync, closeSync } from 'node:fs'

// Official 2.1.292 drains finite SDK JSONL from redirected files and pipes.
// Main captures stdin before awaiting startup; Bun 1.3.14 can lose file fd 0.
for (const inputKind of ['file', 'pipe'] as const) {
  test(`SDK stdin preserves all bytes from a preloaded ${inputKind}`, async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'sdk-stdin-')))
    const entry = join(home, 'entry.mjs')
    const module = new URL('./stdin.ts', import.meta.url).href
    await writeFile(entry, `import { getStdinStream } from ${JSON.stringify(module)};
const input = getStdinStream();
await Promise.resolve();
let data = ''; for await (const chunk of input) data += chunk;
const { fstatSync } = await import('node:fs');
const kind = fstatSync(0).isFile() ? 'file' : 'pipe';
console.log(JSON.stringify({ data, kind, original: input === process.stdin, fileRemainsOpen: kind === 'file' ? fstatSync(0).isFile() : null }));
`)
    const data = '{"type":"control_request","request_id":"初始化😀","request":{"subtype":"initialize"}}\n{"type":"control_request","request_id":"end","request":{"subtype":"end_session"}}'
    const file = join(home, 'input.jsonl')
    await writeFile(file, data)
    const descriptor = inputKind === 'file' ? openSync(file, 'r') : undefined
    const child = Bun.spawn([process.execPath, entry], {
      env: { PATH: process.env.PATH, HOME: home },
      stdin: descriptor ?? new Blob([data]), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      expect(JSON.parse(stdout)).toEqual({ data, kind: inputKind, original: inputKind === 'pipe', fileRemainsOpen: inputKind === 'file' ? true : null })
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited }
      if (descriptor !== undefined) closeSync(descriptor)
      await rm(home, { recursive: true, force: true })
    }
  })
}
