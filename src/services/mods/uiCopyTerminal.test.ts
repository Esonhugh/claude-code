import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdtemp, realpath, rm, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

let root: string
beforeEach(async () => {root = await realpath(await mkdtemp(join(tmpdir(), 'owned-copy-terminal-')))})
afterEach(async () => {await rm(root, {recursive: true, force: true})})

async function copy(text: string, suffix: string) {
  const dir = join(root, suffix);await mkdir(dir)
  const input = join(dir, 'input.json'), script = join(dir, 'child.mjs')
  await writeFile(input, JSON.stringify(text))
  await writeFile(script, `import {readFile} from 'node:fs/promises';
    const {copyModTerminalText}=await import(process.argv[2]);
    const text=JSON.parse(await readFile(process.argv[3],'utf8'));
    const result=await copyModTerminalText(text,'owned-copy');
    console.error('OWNED_COPY_RESULT '+JSON.stringify(result));`)
  const child = Bun.spawn([process.execPath, script, new URL('./uiCopy.ts', import.meta.url).pathname, input], {
    cwd: dir, env: {PATH: '/usr/bin:/bin', HOME: dir, CLAUDE_CONFIG_DIR: dir, XDG_CONFIG_HOME: dir,
      TMPDIR: dir, TERM: 'xterm-256color', SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 2',
      DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'},
    stdout: 'pipe', stderr: 'pipe',
  })
  let timer: ReturnType<typeof setTimeout>
  try {
    const work = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const [stdout, stderr, code] = await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {child.kill();reject(Error('owned clipboard child did not finish'))}, 4000)
    })])
    expect(code).toBe(0)
    const receipt = stderr.split('\n').find(line => line.startsWith('OWNED_COPY_RESULT '))
    expect(receipt).toBeDefined()
    return {stdout, result: JSON.parse(receipt!.slice('OWNED_COPY_RESULT '.length))}
  } finally {clearTimeout(timer!)}
}

test('the production terminal path writes only an OSC clipboard payload with verbatim UTF-8', async () => {
  const text = 'a\n你好 🧪'
  const {stdout, result} = await copy(text, 'verbatim')
  expect(result).toEqual({isCopied: true})
  expect(stdout).toBe('\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07')
})

test('the production OSC path accepts exactly 1 MiB and returns no-clipboard over the bound', async () => {
  const exact = await copy('x'.repeat(786426), 'exact')
  expect(exact.result).toEqual({isCopied: true})
  expect(exact.stdout.length).toBe(1048576)
  const over = await copy('x'.repeat(786427), 'over')
  expect(over.result).toEqual({isCopied: false, reason: 'no-clipboard'})
  expect(over.stdout).toBe('')
})
