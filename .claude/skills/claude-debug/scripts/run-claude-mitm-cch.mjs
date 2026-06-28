#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg?.startsWith('--')) {
    const next = process.argv[i + 1]
    args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'true')
    if (next && !next.startsWith('--')) i += 1
  }
}

const repo = resolve(args.get('repo') ?? process.cwd())
const prompt = args.get('prompt') ?? 'hello'
const only = args.get('only') ?? 'both'
const timeoutMs = Number(args.get('timeout-ms') ?? 180000)
const outputPath = args.get('output') ? resolve(args.get('output')) : null
const artifactRoot = args.get('artifact-root') ? resolve(args.get('artifact-root')) : mkdtempSync(join(tmpdir(), 'claude-mitm-cch-run-'))
const mitmScript = join(dirname(fileURLToPath(import.meta.url)), 'mitm-cch-debug.mjs')

function runChecked(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed: ${result.stderr}`)
}

function createCerts(root) {
  const caKey = join(root, 'ca.key.pem')
  const caCert = join(root, 'ca.crt.pem')
  const leafKey = join(root, 'leaf.key.pem')
  const leafCsr = join(root, 'leaf.csr.pem')
  const leafCert = join(root, 'leaf.crt.pem')
  const ext = join(root, 'leaf.ext')
  runChecked('openssl', ['genrsa', '-out', caKey, '2048'])
  runChecked('openssl', ['req', '-x509', '-new', '-nodes', '-key', caKey, '-sha256', '-days', '1', '-subj', '/CN=Claude Debug Local CA', '-out', caCert])
  runChecked('openssl', ['genrsa', '-out', leafKey, '2048'])
  runChecked('openssl', ['req', '-new', '-key', leafKey, '-subj', '/CN=ai-gw.mjclouds.com', '-out', leafCsr])
  writeFileSync(ext, 'subjectAltName=DNS:api.anthropic.com,DNS:ai-gw.mjclouds.com,DNS:registry.npmjs.org,DNS:downloads.claude.ai\nextendedKeyUsage=serverAuth\n')
  runChecked('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', leafCert, '-days', '1', '-sha256', '-extfile', ext])
  return { caCert, leafCert, leafKey }
}

function waitForProxy(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MITM proxy did not start')), 5000)
    child.stdout.on('data', chunk => {
      if (chunk.toString('utf8').includes('mitm cch debug listening')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', chunk => reject(new Error(chunk.toString('utf8'))))
    child.on('exit', code => reject(new Error(`MITM proxy exited ${code}`)))
  })
}

function parseJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function runBinary(name, env) {
  const stdoutPath = join(artifactRoot, `${name}.stdout.txt`)
  const stderrPath = join(artifactRoot, `${name}.stderr.txt`)
  const started = Date.now()
  const child = spawnSync(resolve(repo, name), ['--print', prompt, '--dangerously-skip-permissions'], {
    cwd: repo,
    env,
    encoding: 'buffer',
    timeout: timeoutMs,
  })
  writeFileSync(stdoutPath, child.stdout ?? Buffer.alloc(0))
  writeFileSync(stderrPath, child.stderr ?? Buffer.alloc(0))
  return {
    name,
    exit_code: child.error?.code === 'ETIMEDOUT' ? 'timeout' : child.status,
    duration_ms: Date.now() - started,
    stdout_bytes: child.stdout?.length ?? 0,
    stderr_bytes: child.stderr?.length ?? 0,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  }
}

const binaries = only === 'both' ? ['built-claude', 'official-claude'] : [only]
const certs = createCerts(artifactRoot)
const logPath = join(artifactRoot, 'mitm-cch.jsonl')
const port = Number(args.get('port') ?? 19120)
const proxy = spawn('node', [mitmScript, '--port', String(port), '--log', logPath, '--cert', certs.leafCert, '--key', certs.leafKey], {
  cwd: repo,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let summary
try {
  await waitForProxy(proxy)
  const env = {
    ...process.env,
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    http_proxy: `http://127.0.0.1:${port}`,
    https_proxy: `http://127.0.0.1:${port}`,
    NO_PROXY: '',
    no_proxy: '',
    NODE_EXTRA_CA_CERTS: certs.caCert,
    SSL_CERT_FILE: certs.caCert,
    REQUESTS_CA_BUNDLE: certs.caCert,
  }
  const runs = []
  for (const binary of binaries) {
    const before = parseJsonl(logPath).length
    const run = runBinary(binary, env)
    await new Promise(resolve => setTimeout(resolve, 500))
    const afterEvents = parseJsonl(logPath).slice(before)
    run.decrypted_requests = afterEvents
      .filter(event => event.type === 'decrypted_request_summary')
      .map(event => ({
        target: event.target,
        request_line: event.request_line,
        header_count: event.headers?.length ?? 0,
        body_summary: event.body_summary,
      }))
    run.connect_targets = [...new Set(afterEvents.filter(event => event.type === 'connect').map(event => event.target))]
    runs.push(run)
  }
  summary = {
    artifact_root: artifactRoot,
    mitm_log: logPath,
    ca_cert: certs.caCert,
    proxy: `http://127.0.0.1:${port}`,
    runs,
  }
} finally {
  proxy.kill('SIGTERM')
}

const output = JSON.stringify(summary, null, 2)
if (outputPath) writeFileSync(outputPath, output)
console.log(output)
