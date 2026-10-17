const noiseDirectories = new Set([
  'test',
  'tests',
  'spec',
  'specs',
  '__tests__',
  '__mocks__',
  '__snapshots__',
  '__fixtures__',
  'fixtures',
  'testdata',
  'dist',
  'build',
  'out',
  'output',
  'node_modules',
  'vendor',
  'vendored',
  'third_party',
  'third-party',
  'external',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.tox',
  'venv',
  '.venv',
])
const lockNames = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lockb',
  'shrinkwrap.json',
  'npm-shrinkwrap.json',
])

export function isDiffNoise(path: string): boolean {
  const parts = path.split('/')
  const name = parts.pop()!.toLowerCase()
  if (
    parts.some(
      (part, index) =>
        noiseDirectories.has(part) ||
        part.endsWith('.generated') ||
        (part === 'target' &&
          ['release', 'debug'].includes(parts[index + 1] ?? '')),
    )
  )
    return true
  return (
    lockNames.has(name) ||
    name.endsWith('.lock') ||
    name.endsWith('.d.ts') ||
    /[._](?:test|spec)\.[a-z]+$/.test(name) ||
    /(?:\.min|-min|\.bundle|\.generated|\.gen|\.auto|_generated|_gen|\.grpc|\.swagger|\.openapi)\.[a-z]+$/.test(
      name,
    ) ||
    /(?:\.pb\.(?:go|js|ts|py|rb|h)|_pb2?\.py|\.snap)$/.test(name)
  )
}
