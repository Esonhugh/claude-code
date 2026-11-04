// Diagnostic (temporary): how long `srt-win wfp verify` takes right after
// `claude sandbox install` on a fresh runner, and on later calls.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const bin = path.resolve(process.argv[2] ?? '')
const srtWin = path.resolve('node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wfp-timing-'))
const env = { ...process.env, CLAUDE_CONFIG_DIR: root }

const profiles = () => fs.readdirSync('C:\\Users').filter(n => /sandbox/i.test(n))
console.log(`profiles before install: ${JSON.stringify(profiles())}`)
let t = Date.now()
const install = spawnSync(bin, ['sandbox', 'install'], { env, encoding: 'utf8' })
console.log(`install ${Date.now() - t}ms exit=${install.status} ${install.stdout.trim()}`)
console.log(`profiles after install: ${JSON.stringify(profiles())}`)

for (let i = 1; i <= 4; i++) {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  const target = `127.0.0.1:${(server.address() as net.AddressInfo).port}`
  t = Date.now()
  const r = await new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(srtWin, ['wfp', 'verify', '--target', target], { windowsHide: true })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    const timer = setTimeout(() => child.kill(), 180000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out: out.trim() })
    })
  })
  server.close()
  console.log(`verify #${i}: ${Date.now() - t}ms exit=${r.code} ${r.out.slice(0, 300)}`)
  if (i === 1) console.log(`profiles after verify #1: ${JSON.stringify(profiles())}`)
}
