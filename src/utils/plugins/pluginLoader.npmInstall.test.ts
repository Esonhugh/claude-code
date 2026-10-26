import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFromNpm } from './pluginLoader.js'

const saved = {
  PATH: process.env.PATH,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
}
let root: string | undefined

afterEach(() => {
  process.env.PATH = saved.PATH
  if (saved.CLAUDE_CODE_PLUGIN_CACHE_DIR === undefined)
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = saved.CLAUDE_CODE_PLUGIN_CACHE_DIR
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

test('npm plugin install never runs package lifecycle scripts', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-plugin-install-')))
  const bin = join(root, 'bin')
  const argsFile = join(root, 'npm-args')
  mkdirSync(bin)
  // Fake npm: record argv, then lay out the package the way `npm install --prefix` would.
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; fi
  shift
done
mkdir -p "$prefix/node_modules/demo-plugin"
echo '{"name":"demo-plugin"}' > "$prefix/node_modules/demo-plugin/package.json"
`,
  )
  chmodSync(join(bin, 'npm'), 0o755)
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'plugins')

  await installFromNpm('demo-plugin', join(root, 'target'))

  const args = readFileSync(argsFile, 'utf8').trim().split('\n')
  expect(args[0]).toBe('install')
  expect(args).toContain('--ignore-scripts')
  expect(readFileSync(join(root, 'target', 'package.json'), 'utf8')).toContain(
    'demo-plugin',
  )
})
