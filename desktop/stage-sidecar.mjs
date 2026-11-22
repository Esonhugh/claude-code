// Copies a built `claude` binary to sidecar/, where electron-builder picks it up.
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const source = process.argv[2] ?? resolve(import.meta.dirname, '..', 'built-claude')
const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
const dir = join(import.meta.dirname, 'sidecar')
mkdirSync(dir, { recursive: true })
copyFileSync(source, join(dir, name))
chmodSync(join(dir, name), 0o755)
console.log(`${source} -> sidecar/${name}`)
