import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

// The recovered project disables strictNullChecks. Check this finite protocol
// separately so required nullable fields cannot silently become optional.
const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
)
const result = spawnSync(
  process.execPath,
  [
    compiler,
    '--noEmit',
    '--pretty',
    'false',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    '--lib',
    'ES2023,DOM',
    '--types',
    'bun,node',
    '--skipLibCheck',
    'tests/type-contracts/mods-ui-protocol.ts',
  ],
  { cwd: root, stdio: 'inherit', timeout: 60000 },
)
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
