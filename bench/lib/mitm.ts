import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const HOSTS = ['api.anthropic.com', 'chatgpt.com', 'api.openai.com']

// A throwaway CA + leaf for the logging proxy, kept in the work dir (never in the repo).
// bundle.crt = the upstream trust store + this CA, given to every CLI.
export function ensureMitm(dir: string, upstreamCa = process.env.SSL_CERT_FILE): { dir: string; bundle: string } {
  const bundle = path.join(dir, 'bundle.crt')
  if (fs.existsSync(bundle)) return { dir, bundle }
  fs.mkdirSync(dir, { recursive: true })
  const ssl = (...args: string[]) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr}`)
  }
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '30', '-subj', '/CN=agent-bench MITM CA')
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=agent-bench')
  fs.writeFileSync(
    path.join(dir, 'leaf.ext'),
    `subjectAltName=${HOSTS.map(h => `DNS:${h}`).join(',')}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  )
  ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '30', '-extfile', 'leaf.ext')
  const upstream = upstreamCa && fs.existsSync(upstreamCa) ? fs.readFileSync(upstreamCa, 'utf8') : ''
  fs.writeFileSync(bundle, `${upstream.trimEnd()}\n${fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8')}`)
  return { dir, bundle }
}

const waitPort = (port: number, ms: number) =>
  new Promise<boolean>(resolve => {
    const end = Date.now() + ms
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => (Date.now() > end ? resolve(false) : setTimeout(tryOnce, 100)))
    }
    tryOnce()
  })

export async function startProxy(port: number, logFile: string, mitmDir: string): Promise<ChildProcess> {
  const child = spawn('node', [path.join(import.meta.dir, 'proxy.mjs'), String(port), logFile], {
    env: {
      PATH: process.env.PATH,
      BENCH_MITM_DIR: mitmDir,
      UPSTREAM_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '',
      BENCH_UPSTREAM_CA: process.env.BENCH_UPSTREAM_CA ?? process.env.SSL_CERT_FILE ?? '',
      ...(process.env.BENCH_DIRECT_HOSTS != null ? { BENCH_DIRECT_HOSTS: process.env.BENCH_DIRECT_HOSTS } : {}),
    },
    stdio: 'ignore',
  })
  if (!(await waitPort(port, 5000))) {
    child.kill()
    throw new Error(`proxy did not start on ${port}`)
  }
  return child
}
