import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { unzipSync } from 'fflate'

export const COMMIT = '7974a70773fa229e4cc65aa1b356cc21f5c216c4'
export const OFFICIAL = ['diff', 'agents-md', 'sec-default', 'telemetry']
const OWNER = 'mods-test-lab/v1'
const SCRIPT = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SCRIPT), '..')
const SOURCE = `https://github.com/anthropics/claude-code/tree/${COMMIT}/mods`
const TREE = `https://api.github.com/repos/anthropics/claude-code/git/trees/${COMMIT}?recursive=1`
const ARCHIVE = `https://codeload.github.com/anthropics/claude-code/zip/${COMMIT}`
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJSON = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`
const commandText = args => args.map(quote).join(' ')
const within = (root, path) => { const part = relative(root, path); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)) }

export function parseArgs(args) {
  const [command, ...rest] = args
  if (!['fetch-official', 'check', 'run', 'run-builtin', 'accept-builtin', 'clean'].includes(command)) throw new Error('Usage: fetch-official | check <sample|diff|agents-md|sec-default|telemetry> | run <name> [--binary PATH] [--api-url http://127.0.0.1:PORT] | run-builtin [--binary PATH] [--api-url http://127.0.0.1:PORT] | accept-builtin [--binary PATH] | clean <run-id>; all accept --cache DIR')
  const options = { command, cache: join(homedir(), 'Library', 'Caches', 'mods-test-lab'), binary: join(REPO, 'built-claude'), apiUrl: 'http://127.0.0.1:1' }
  const seen = new Set()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('-') && !options.target) { options.target = arg; continue }
    const key = { '--cache': 'cache', '--binary': 'binary', '--api-url': 'apiUrl' }[arg]
    if (!key || seen.has(key) || !rest[i + 1] || rest[i + 1].startsWith('--') || (key !== 'cache' && !['run', 'run-builtin', 'accept-builtin'].includes(command)) || (command === 'accept-builtin' && key === 'apiUrl')) throw new Error(`Invalid argument: ${arg}`)
    seen.add(key)
    options[key] = rest[++i]
  }
  if (['fetch-official', 'run-builtin', 'accept-builtin'].includes(command) ? options.target !== undefined : !options.target) throw new Error('Unexpected or missing target')
  if (['check', 'run'].includes(command) && !['sample', ...OFFICIAL].includes(options.target)) throw new Error('Unknown Mod')
  const url = new URL(options.apiUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('API URL must be an explicit loopback HTTP port, without credentials or path')
  options.cache = resolve(options.cache)
  options.binary = resolve(options.binary)
  return options
}

function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error(`Not an owned directory: ${path}`)
  return realpathSync(path)
}

function cacheDirectory(path) {
  if (within(REPO, resolve(path))) throw new Error('Cache must be outside the repository')
  const root = directory(path)
  if (within(realpathSync(REPO), root)) throw new Error('Cache must be outside the repository')
  return root
}

export function inventory(root) {
  const files = []
  function walk(path) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported file/link: ${path}`)
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
    else files.push({ path: relative(root, path).split(sep).join('/'), size: stat.size, sha256: sha256(readFileSync(path)) })
  }
  walk(root)
  return { files, sha256: sha256(JSON.stringify(files)) }
}

function selected(path) { return ['types', ...OFFICIAL].some(name => path.startsWith(`mods/${name}/`)) }
function safePath(path) { return typeof path === 'string' && path && !path.includes('\\') && [...path].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) && path.split('/').every(part => part && part !== '.' && part !== '..') }

export function downloadPublic(url, destination) {
  execFileSync('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--proxy', 'http://127.0.0.1:7890', '--noproxy', '', '--connect-timeout', '10', '--max-time', '120', '--max-filesize', '134217728', '--output', destination, url], {
    env: { PATH: '/usr/bin:/bin', HOME: dirname(destination) }, timeout: 125000, stdio: ['ignore', 'ignore', 'pipe'],
  })
}

function validSnapshot(path) {
  try {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || !lstatSync(join(path, 'inventory.json')).isFile() || lstatSync(join(path, 'inventory.json')).isSymbolicLink()) return false
    const record = json(join(path, 'inventory.json'))
    const actual = inventory(join(path, 'mods'))
    return record.owner === OWNER && record.commit === COMMIT && record.source === SOURCE && record.sha256 === actual.sha256 && JSON.stringify(record.files) === JSON.stringify(actual.files) && OFFICIAL.every(name => record.manifests[name]?.name === name && record.manifests[name]?.version === '0.1.0' && JSON.stringify(record.manifests[name]) === JSON.stringify(json(join(path, 'mods', name, '.claude-plugin/plugin.json')))) && actual.files.some(file => file.path === 'types/claude-code.d.ts')
  } catch { return false }
}

export function findOfficial(cache) {
  const root = join(cache, 'official', COMMIT)
  if (!existsSync(root)) return undefined
  if (realpathSync(root) !== root) throw new Error('Official cache directory may not be a link')
  return readdirSync(root).sort().reverse().filter(name => name.startsWith('snapshot-')).map(name => join(root, name)).find(validSnapshot)
}

export function fetchOfficial(cache, download = downloadPublic) {
  cache = cacheDirectory(cache)
  const previous = findOfficial(cache)
  if (previous) return { path: previous, reused: true, ...json(join(previous, 'inventory.json')) }
  directory(join(cache, 'official'))
  const root = directory(join(cache, 'official', COMMIT))
  const staging = mkdtempSync(join(root, '.stage-'))
  // Failed stages and invalid snapshots remain evidence; only complete new snapshots are published.
  download(TREE, join(staging, 'tree.json'))
  const tree = json(join(staging, 'tree.json'))
  if (tree.truncated !== false || !/^[a-f0-9]{40}$/.test(tree.sha) || !Array.isArray(tree.tree)) throw new Error('Incomplete official tree')
  const expected = new Map()
  for (const entry of tree.tree) {
    if (!safePath(entry.path)) throw new Error(`Unsafe upstream path: ${entry.path}`)
    if (!selected(entry.path) || entry.type === 'tree') continue
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha) || expected.has(entry.path)) throw new Error(`Unsupported upstream file/link: ${entry.path}`)
    expected.set(entry.path, entry)
  }
  download(ARCHIVE, join(staging, 'source.zip'))
  const prefix = `claude-code-${COMMIT}/`
  const extracted = new Set()
  const archive = unzipSync(readFileSync(join(staging, 'source.zip')), { filter: file => {
    const path = file.name.endsWith('/') ? file.name.slice(0, -1) : file.name
    if (!safePath(path) || !file.name.startsWith(prefix)) throw new Error(`Unsafe archive path: ${file.name}`)
    const wanted = expected.has(file.name.slice(prefix.length))
    if (wanted && (extracted.has(file.name) || file.originalSize > 16 * 1024 * 1024)) throw new Error('Duplicate or oversized archive member')
    if (wanted) extracted.add(file.name)
    return wanted
  } })
  for (const [path, entry] of expected) {
    const bytes = archive[prefix + path]
    if (!bytes || bytes.length !== entry.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new Error(`Missing or changed upstream file: ${path}`)
    const output = join(staging, path)
    directory(dirname(output))
    writeFileSync(output, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o700 : 0o600 })
  }
  const manifests = Object.fromEntries(OFFICIAL.map(name => [name, json(join(staging, 'mods', name, '.claude-plugin/plugin.json'))]))
  if (OFFICIAL.some(name => manifests[name].name !== name || manifests[name].version !== '0.1.0')) throw new Error('Unexpected official manifests')
  if (!existsSync(join(staging, 'mods/types/claude-code.d.ts'))) throw new Error('Missing complete author types')
  const record = { owner: OWNER, commit: COMMIT, treeSha: tree.sha, source: SOURCE, archive: ARCHIVE, manifests, ...inventory(join(staging, 'mods')) }
  writeJSON(join(staging, 'inventory.json'), record)
  rmSync(join(staging, 'source.zip')) // Keep only the selected sources, not unrelated repository contents.
  const published = join(root, `snapshot-${basename(staging).slice(7)}`)
  renameSync(staging, published)
  return { path: published, reused: false, ...record }
}

export function createRun(cache, kind) {
  cache = cacheDirectory(cache)
  const root = directory(join(cache, 'runs'))
  const id = `r-${randomBytes(6).toString('hex')}`
  const run = join(root, id)
  mkdirSync(run, { mode: 0o700 })
  writeJSON(join(run, '.mods-test-lab.json'), { owner: OWNER, cache, id, kind, uid: process.getuid?.(), launcherPid: process.pid, createdAt: new Date().toISOString() })
  return run
}

export function fixtureEnvironment(run, apiUrl = 'http://127.0.0.1:1') {
  return {
    HOME: join(run, 'home'), CLAUDE_CONFIG_DIR: join(run, 'config'), XDG_CONFIG_HOME: join(run, 'xdg'), XDG_CACHE_HOME: join(run, 'xdg-cache'), XDG_DATA_HOME: join(run, 'xdg-data'), TMPDIR: join(run, 'tmp'), TMP: join(run, 'tmp'), TEMP: join(run, 'tmp'),
    PATH: `${join(run, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-mods-test-lab-fake-not-a-credential', ANTHROPIC_BASE_URL: apiUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  }
}

export function prepareFixture(run, plugin) {
  for (const name of ['home', 'config', 'xdg', 'xdg-cache', 'xdg-data', 'tmp', 'bin', 'project']) directory(join(run, name))
  writeFileSync(join(run, 'bin/security'), '#!/bin/sh\nexit 44\n', { flag: 'wx', mode: 0o700 })
  if (plugin !== undefined) {
    inventory(plugin) // Do not copy links to user files into the fixture.
    cpSync(plugin, join(run, 'plugin'), { recursive: true, errorOnExist: true, force: false })
  }
  const cwd = join(run, 'project')
  const env = fixtureEnvironment(run)
  const git = args => execFileSync('/usr/bin/git', args, { cwd, env, stdio: 'pipe', timeout: 10000 })
  git(['init', '--template='])
  directory(join(cwd, '.git/info'))
  writeFileSync(join(cwd, 'AGENTS.md'), 'MODS_TEST_LAB_AGENTS_MARKER\n')
  writeFileSync(join(cwd, 'tracked.txt'), 'before\n')
  git(['add', 'AGENTS.md', 'tracked.txt'])
  git(['-c', 'user.name=Mods Test Lab', '-c', 'user.email=mods-test-lab@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Private fixture'])
  writeFileSync(join(cwd, 'tracked.txt'), 'after\n')
  writeJSON(join(run, 'config/settings.json'), { enabledPlugins: {}, extraKnownMarketplaces: {}, skipDangerousModePermissionPrompt: true })
  writeJSON(join(run, 'config/.claude.json'), { hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } })
  return env
}

export function sandboxProfile(run, inspect = false) {
  const path = value => JSON.stringify(value)
  const home = realpathSync(homedir())
  const exceptions = [`(require-not (subpath ${path(run)}))`, ...(inspect ? [`(require-not (subpath ${path(REPO)}))`] : [])]
  return `(version 1)\n(allow default)\n(deny file-write* (require-all (require-not (subpath ${path(run)})) (require-not (subpath "/dev"))))\n(deny network*)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-bind (local ip "localhost:*"))\n(allow network* (local unix-socket) (remote unix-socket))\n(deny process-exec (literal "/usr/bin/security"))\n(deny file-read* (require-all (subpath ${path(home)}) ${exceptions.join(' ')}))\n${[join(home, 'Library/Keychains'), '/Library/Keychains', '/System/Library/Keychains', '/Library/Managed Preferences', '/Library/Application Support/ClaudeCode', '/etc/claude-code', join(REPO, '.claude'), join(REPO, '.env')].map(value => `(deny file-read* (subpath ${path(value)}))`).join('\n')}\n(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))\n`
}

export async function inspectPlugin(plugin) {
  globalThis.MACRO = { VERSION: 'mods-test-lab-check' }
  const { setOriginalCwd, setInlinePlugins, setAllowedSettingSources } = await import('../src/bootstrap/state.ts')
  setOriginalCwd(process.cwd())
  setAllowedSettingSources(['userSettings'])
  setInlinePlugins([plugin])
  const { loadAllPluginsCacheOnly } = await import('../src/utils/plugins/pluginLoader.ts')
  const { prepareModPlugins } = await import('../src/services/mods/plugins.ts')
  const { loadModDeclaration } = await import('../src/services/mods/loader.ts')
  const discovered = await loadAllPluginsCacheOnly()
  const loaded = discovered.enabled.filter(item => item.path === plugin)
  const prepared = prepareModPlugins(loaded, { userSettings: {}, flagSettings: null, policySettings: null, hookPolicy: { managedOnly: false, allDisabled: false } })
  const result = { discovery: loaded.length ? 'passed' : 'failed', preparation: prepared.inputs.length && !prepared.errors.length ? 'passed' : 'failed', scan: 'not-run', admission: 'not-run (runtime plugin.register requires activation)', activation: 'not-run', trigger: 'not-run', errors: [...discovered.errors, ...prepared.errors], declarations: [] }
  for (const input of prepared.inputs) {
    try {
      const declaration = await loadModDeclaration(input)
      result.declarations.push({ name: declaration.name, tier: declaration.tier, fingerprint: declaration.fingerprint, events: declaration.events, calls: declaration.calls, modules: declaration.modules.length })
    } catch (error) { result.errors.push({ stage: 'scan', message: error.message }) }
  }
  if (prepared.inputs.length) result.scan = result.declarations.length === prepared.inputs.length ? 'passed' : 'failed'
  return result
}

function pluginPath(cache, name) {
  if (name === 'sample') return join(REPO, 'examples/mods/mods-test-lab')
  const snapshot = findOfficial(cache)
  if (!snapshot) throw new Error('No valid official cache; run fetch-official first (nothing is downloaded or executed by check/run)')
  return join(snapshot, 'mods', name)
}

function sandboxCommand(run, argv, inspect = false) {
  if (process.platform !== 'darwin') throw new Error('check/run currently require macOS sandbox-exec; no unisolated fallback')
  const profile = join(run, 'sandbox.sb')
  writeFileSync(profile, sandboxProfile(run, inspect), { flag: 'wx', mode: 0o600 })
  return ['/usr/bin/sandbox-exec', '-f', profile, ...argv]
}

export function check(options) {
  const source = pluginPath(cacheDirectory(options.cache), options.target)
  const run = createRun(options.cache, 'check')
  const env = prepareFixture(run, source)
  const expression = `const {inspectPlugin} = await import(${JSON.stringify(SCRIPT)}); console.log(JSON.stringify(await inspectPlugin(${JSON.stringify(join(run, 'plugin'))})))`
  const argv = sandboxCommand(run, [process.execPath, '--eval', expression], true)
  const child = spawnSync(argv[0], argv.slice(1), { cwd: join(run, 'project'), env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(run, 'check.stderr.log'), child.stderr ?? '')
  writeFileSync(join(run, 'check.stdout.log'), child.stdout ?? '')
  if (child.error || child.status !== 0) throw new Error(`Check failed; evidence ${run}: ${child.error?.message ?? child.stderr}`)
  const report = { run, source, downloaded: options.target !== 'sample', ...JSON.parse(child.stdout) }
  writeJSON(join(run, 'check.json'), report)
  console.log(JSON.stringify(report, null, 2))
  return report
}

export function startRun(options) {
  const source = pluginPath(cacheDirectory(options.cache), options.target)
  const run = createRun(options.cache, 'run')
  const socket = join(run, 'tmux.sock')
  if (Buffer.byteLength(socket) >= 100) throw new Error(`Socket path too long; use --cache /private/tmp/mods-test-lab. Preserved ${run}`)
  const tmux = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim()
  const env = prepareFixture(run, source)
  env.ANTHROPIC_BASE_URL = options.apiUrl
  cpSync(options.binary, join(run, 'bin/claude'), { errorOnExist: true, force: false })
  const debug = join(run, 'debug.log')
  const argv = sandboxCommand(run, [join(run, 'bin/claude'), '--dangerously-skip-permissions', '--plugin-dir', join(run, 'plugin'), '--setting-sources', 'user,project,local', '--debug-file', debug])
  const metadata = { run, socket, session: 'mods', source, binary: options.binary, binarySha256: sha256(readFileSync(join(run, 'bin/claude'))), plugin: inventory(join(run, 'plugin')), debug, env, argv, uiOnly: options.apiUrl === 'http://127.0.0.1:1', activation: 'not-verified', trigger: 'not-run' }
  writeJSON(join(run, 'command.json'), metadata)
  const tmuxConfig = join(run, 'tmux.conf')
  writeFileSync(tmuxConfig, 'set-option -g default-shell /bin/sh\nset-option -g remain-on-exit on\n', { flag: 'wx', mode: 0o600 })
  const child = execFileSync(tmux, ['-S', socket, '-f', tmuxConfig, 'new-session', '-d', '-s', 'mods', '-x', '160', '-y', '50', '-c', join(run, 'project'), '-P', '-F', '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pid}', ...argv], { env, encoding: 'utf8', timeout: 10000 }).trim()
  const [target, pane, serverPid] = child.split(/\s+/)
  const tmuxArgs = [tmux, '-S', socket]
  const input = options.target === 'sample' ? '/mods-test status' : options.target === 'diff' ? '/diff' : '/plugins'
  const report = { ...metadata, target, pane, serverPid: Number(serverPid), tmux, attach: commandText([...tmuxArgs, 'attach-session', '-t', 'mods']), input: commandText([...tmuxArgs, 'send-keys', '-t', target, '-l', input]), enter: commandText([...tmuxArgs, 'send-keys', '-t', target, 'Enter']), capture: `${commandText([...tmuxArgs, 'capture-pane', '-p', '-t', target])} > ${quote(join(run, 'capture.txt'))}`, exit: commandText([...tmuxArgs, 'send-keys', '-t', target, '-l', '/exit']), seal: `touch ${quote(join(run, 'SEALED'))}`, clean: commandText([process.execPath, SCRIPT, 'clean', basename(run), '--cache', realpathSync(options.cache)]), note: 'Session creation is not readiness/activation. Default API is a closed loopback port: use commands/UI only. No managed identity, builtin pin override, real credentials or telemetry endpoints. /exit then Enter before clean; capture/seal evidence first.' }
  writeJSON(join(run, 'run.json'), report)
  console.log(JSON.stringify(report, null, 2))
  return report
}

export function startBuiltinRun(options, execute = execFileSync, findTmux = () => execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim(), configure) {
  const cache = cacheDirectory(options.cache)
  if (!existsSync(options.binary) || !lstatSync(options.binary).isFile()) throw new Error(`Built Claude binary not found: ${options.binary}`)
  const run = createRun(cache, 'run-builtin')
  const socket = join(run, 'tmux.sock')
  if (Buffer.byteLength(socket) >= 100) throw new Error(`Socket path too long; use --cache /private/tmp/mods-test-lab. Preserved ${run}`)
  const tmux = findTmux()
  const env = prepareFixture(run)
  env.ANTHROPIC_BASE_URL = options.apiUrl
  delete env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE
  configure?.(run, env)
  const binary = join(run, 'bin/claude')
  cpSync(options.binary, binary, { errorOnExist: true, force: false })
  const debug = join(run, 'debug.log')
  const argv = sandboxCommand(run, [binary, '--dangerously-skip-permissions', '--setting-sources', 'user,project,local', '--debug-file', debug])
  const metadata = { run, socket, session: 'mods', mode: 'builtin-only', binary: options.binary, binarySha256: sha256(readFileSync(binary)), debug, env, argv, uiOnly: options.apiUrl === 'http://127.0.0.1:1', activation: 'not-verified', trigger: 'not-run' }
  writeJSON(join(run, 'command.json'), metadata)
  const tmuxConfig = join(run, 'tmux.conf')
  writeFileSync(tmuxConfig, 'set-option -g default-shell /bin/sh\nset-option -g remain-on-exit on\n', { flag: 'wx', mode: 0o600 })
  const child = execute(tmux, ['-S', socket, '-f', tmuxConfig, 'new-session', '-d', '-s', 'mods', '-x', '160', '-y', '50', '-c', join(run, 'project'), '-P', '-F', '#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{pid}', ...argv], { env, encoding: 'utf8', timeout: 10000 }).trim()
  const [target, pane, serverPid] = child.split(/\s+/)
  const tmuxArgs = [tmux, '-S', socket]
  const report = { ...metadata, target, pane, serverPid: Number(serverPid), tmux, attach: commandText([...tmuxArgs, 'attach-session', '-t', 'mods']), capture: `${commandText([...tmuxArgs, 'capture-pane', '-p', '-t', target])} > ${quote(join(run, 'capture.txt'))}`, exit: commandText([...tmuxArgs, 'send-keys', '-t', target, '-l', '/exit']), enter: commandText([...tmuxArgs, 'send-keys', '-t', target, 'Enter']), seal: `touch ${quote(join(run, 'SEALED'))}`, clean: commandText([process.execPath, SCRIPT, 'clean', basename(run), '--cache', cache]), note: 'Builtin-only compiled launch: no --plugin-dir and no CLAUDE_CODE_BUILTIN_MODS_ARCHIVE override. Session creation is not readiness/activation. Default API is a closed loopback port; no external provider is contacted unless explicitly changed.' }
  writeJSON(join(run, 'run.json'), report)
  console.log(JSON.stringify(report, null, 2))
  return report
}

export async function startAcceptanceProvider(root) {
  const requests = []
  const ledger = join(root, 'requests.jsonl')
  writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 })
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(new URL(req.url, 'http://127.0.0.1').pathname)) {
      res.writeHead(404).end(); return
    }
    try {
      let bytes = ''
      for await (const chunk of req) {
        bytes += chunk
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Request too large')
      }
      const body = JSON.parse(bytes)
      if (req.url.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ input_tokens: 100 })); return }
      const record = { sequence: requests.length + 1, path: req.url, body }
      requests.push(record)
      appendFileSync(ledger, `${JSON.stringify(record)}\n`)
      const message = { id: `msg_lab_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'MODS_ACCEPT_RESPONSE' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 8 } }
      if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MODS_ACCEPT_RESPONSE' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    } catch { res.writeHead(400).end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) }
}

export function assessBuiltinAcceptance(pair) {
  const main = side => side.requests.filter(row => row.body.model === 'claude-sonnet-4-5-20250929' && JSON.stringify(row.body.messages).includes('MODS_ACCEPT_PROMPT'))
  const enabled = main(pair.enabled), disabled = main(pair.disabled)
  const markers = ['MODS_ACCEPT_CLAUDE_MARKER', 'MODS_TEST_LAB_AGENTS_MARKER']
  const agents = enabled.length > 0 && disabled.length > 0 &&
    enabled.every(row => markers.every(marker => !JSON.stringify(row.body).includes(marker))) &&
    disabled.every(row => markers.every(marker => JSON.stringify(row.body).includes(marker)))
  const diff = [pair.enabled, pair.disabled].every(side => !side.error && (!side.cleanup || side.cleanup.status === 0)) && pair.enabled.catalog.includes('Toggle the diff panel showing uncommitted changes') &&
    !pair.enabled.catalog.includes('View uncommitted changes and per-turn diffs') &&
    pair.disabled.catalog.includes('View uncommitted changes and per-turn diffs') &&
    !pair.disabled.catalog.includes('Toggle the diff panel showing uncommitted changes') &&
    [pair.enabled, pair.disabled].every(side => ['tracked.txt', '-before', '+after'].every(text => side.diff.includes(text))) &&
    [pair.enabled, pair.disabled].every(side => side.closed.includes('bypass permissions') && !side.closed.includes('tracked.txt') && !side.closed.includes('Enter to view'))
  const privacyOff = pair.privacyOff?.ledger ?? []
  const privacyOn = pair.privacyOn?.ledger ?? []
  const telemetry = privacyOff.length === 0 && privacyOn.length === 2 &&
    privacyOn[0]?.sequence === 1 && privacyOn[0]?.operation === 'authorize' && privacyOn[0]?.granted === true &&
    privacyOn[1]?.sequence === 2 && privacyOn[1]?.operation === 'http' && privacyOn[1]?.method === 'POST' &&
    privacyOn[1]?.host === 'api.anthropic.com' && privacyOn[1]?.path === '/api/event_logging/v2/batch' && privacyOn[1]?.authorized === true
  return {
    agents: { verdict: agents ? 'passed' : 'failed', reason: 'managed-only must remove both native instruction markers from every main request; disabled must retain both' },
    diff: { verdict: diff ? 'passed' : 'failed', reason: 'distinct command catalog ownership plus real diff content and dismissal on both sides' },
    telemetry: { verdict: telemetry ? 'passed' : 'failed', reason: 'privacy off must make zero host calls; privacy on must append exactly authorize then sanitized first-party HTTP evidence' },
  }
}

export async function acceptBuiltin(options) {
  const evidence = createRun(options.cache, 'accept-builtin')
  const pair = {}
  for (const privacyOn of [false, true]) {
    const name = privacyOn ? 'privacyOn' : 'privacyOff'
    const root = directory(join(evidence, name))
    const provider = await startAcceptanceProvider(root)
    let launch
    let ledgerPath
    const side = pair[name] = { ledger: [], requests: provider.requests }
    try {
      launch = startBuiltinRun({ ...options, apiUrl: provider.url }, execFileSync, undefined, (run, env) => {
        ledgerPath = join(run, 'host.jsonl')
        writeFileSync(ledgerPath, '', { flag: 'wx', mode: 0o600 })
        env.CLAUDE_CODE_MODS_ACCEPTANCE_LEDGER = ledgerPath
        env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
        if (privacyOn) {
          delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
          delete env.DISABLE_TELEMETRY
        }
        const path = join(run, 'config/settings.json')
        const settings = json(path)
        settings.enabledPlugins = { 'agents-md@builtin': true, 'diff@builtin': false, 'telemetry@builtin': true }
        settings.pluginConfigs = { 'agents-md@builtin': { options: { instructionFiles: 'managed-only' } } }
        writeFileSync(path, JSON.stringify(settings))
        const configPath = join(run, 'config/.claude.json')
        writeFileSync(configPath, JSON.stringify({ ...json(configPath), projects: { [join(run, 'project')]: { hasTrustDialogAccepted: true } } }))
      })
      side.run = launch.run
      const tmux = (...args) => execFileSync(launch.tmux, ['-S', launch.socket, ...args], { encoding: 'utf8', timeout: 10000 })
      const wait = async predicate => {
        const deadline = Date.now() + 45000
        do {
          const text = tmux('capture-pane', '-p', '-S', '-2000', '-t', launch.target)
          if (predicate(text)) return
          if (tmux('display-message', '-p', '-t', launch.target, '#{pane_dead}').trim() === '1') throw new Error('CLI exited during telemetry acceptance')
          await delay(150)
        } while (Date.now() < deadline)
        throw new Error('Timed out during telemetry acceptance')
      }
      const send = async text => {
        tmux('send-keys', '-t', launch.target, '-l', text)
        await delay(200)
        tmux('send-keys', '-t', launch.target, 'Enter')
      }
      await wait(text => /bypass permissions/i.test(text))
      await send('/reload-plugins')
      await wait(text => text.includes('Reloaded:'))
      await send('MODS_ACCEPT_PROMPT Reply with the fixed response only. Do not use tools.')
      await wait(text => text.includes('MODS_ACCEPT_RESPONSE'))
      await send('/exit')
      const exitDeadline = Date.now() + 45000
      while (tmux('display-message', '-p', '-t', launch.target, '#{pane_dead}').trim() !== '1') {
        if (Date.now() >= exitDeadline) throw new Error('Timed out during telemetry exit')
        await delay(150)
      }
    } catch (error) { side.error = error.message }
    finally {
      if (launch) spawnSync(launch.tmux, ['-S', launch.socket, 'kill-server'], { encoding: 'utf8', timeout: 10000 })
      if (ledgerPath) side.ledger = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      await provider.close()
      writeJSON(join(root, 'result.json'), side)
    }
  }
  for (const enabled of [true, false]) {
    const name = enabled ? 'enabled' : 'disabled'
    const root = directory(join(evidence, name))
    const provider = await startAcceptanceProvider(root)
    let launch
    const side = pair[name] = { requests: provider.requests, catalog: '', diff: '', closed: '', captures: {} }
    try {
      launch = startBuiltinRun({ ...options, apiUrl: provider.url }, execFileSync, undefined, (run, env) => {
        env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
        const path = join(run, 'config/settings.json')
        const settings = json(path)
        settings.enabledPlugins = Object.fromEntries(OFFICIAL.map(mod => [`${mod}@builtin`, mod === 'agents-md' || mod === 'diff' ? enabled : false]))
        settings.pluginConfigs = { 'agents-md@builtin': { options: { instructionFiles: 'managed-only' } } }
        writeFileSync(path, JSON.stringify(settings))
        writeFileSync(join(run, 'project/CLAUDE.md'), 'MODS_ACCEPT_CLAUDE_MARKER\n')
        writeFileSync(join(run, 'project/tracked.txt'), 'before\n')
        const configPath = join(run, 'config/.claude.json')
        writeFileSync(configPath, JSON.stringify({ ...json(configPath), projects: { [join(run, 'project')]: { hasTrustDialogAccepted: true } } }))
      })
      side.run = launch.run
      side.target = launch.target
      side.socket = launch.socket
      side.binarySha256 = launch.binarySha256
      const tmux = (...args) => {
        appendFileSync(join(root, 'commands.jsonl'), `${JSON.stringify(args)}\n`, { mode: 0o600 })
        return execFileSync(launch.tmux, ['-S', launch.socket, ...args], { encoding: 'utf8', timeout: 10000 })
      }
      const capture = label => {
        const text = tmux('capture-pane', '-p', '-S', '-2000', '-t', launch.target)
        const path = join(root, `${label}.txt`)
        writeFileSync(path, text, { mode: 0o600 })
        side.captures[label] = path
        return text
      }
      const wait = async (label, predicate) => {
        const deadline = Date.now() + 45000
        do {
          const text = capture(label)
          if (predicate(text)) return text
          if (tmux('display-message', '-p', '-t', launch.target, '#{pane_dead}').trim() === '1') throw new Error(`CLI exited during ${label}`)
          await delay(150)
        } while (Date.now() < deadline)
        throw new Error(`Timed out during ${label}`)
      }
      const send = async text => { tmux('send-keys', '-t', launch.target, '-l', text); await delay(200); tmux('send-keys', '-t', launch.target, 'Enter') }
      const startup = await wait('startup', text => /Yes, I trust this folder|bypass permissions/i.test(text))
      if (startup.includes('Yes, I trust this folder')) tmux('send-keys', '-t', launch.target, 'Enter')
      await wait('ready', text => /bypass permissions/i.test(text))
      await send('/reload-plugins')
      await wait('reload', text => text.includes('Reloaded:'))
      await send('MODS_ACCEPT_PROMPT Reply with the fixed response only. Do not use tools.')
      await wait('response', text => text.includes('MODS_ACCEPT_RESPONSE'))
      writeFileSync(join(launch.run, 'project/tracked.txt'), 'after\n')
      tmux('send-keys', '-t', launch.target, '-l', '/diff')
      side.catalog = await wait('catalog', text => /Toggle the diff panel showing uncommitted changes|View uncommitted changes and per-turn diffs/.test(text))
      tmux('send-keys', '-t', launch.target, 'Enter')
      const listing = await wait('files', text => text.includes('tracked.txt'))
      if (!listing.includes('before') || !listing.includes('after')) {
        tmux('send-keys', '-t', launch.target, 'Down')
        await delay(200)
        tmux('send-keys', '-t', launch.target, 'Enter')
      }
      side.diff = await wait('diff', text => text.includes('tracked.txt') && text.includes('before') && text.includes('after'))
      tmux('send-keys', '-t', launch.target, 'Escape')
      if (enabled) { await delay(200); tmux('send-keys', '-t', launch.target, 'Escape') }
      side.closed = await wait('closed', text => text.includes('bypass permissions') && !text.includes('tracked.txt') && !text.includes('Enter to view'))
      await send('/exit')
      const exitDeadline = Date.now() + 45000
      while (tmux('display-message', '-p', '-t', launch.target, '#{pane_dead}').trim() !== '1') {
        if (Date.now() >= exitDeadline) throw new Error('Timed out during exit')
        await delay(150)
      }
    } catch (error) { side.error = error.message }
    finally {
      if (launch) {
        const stopped = spawnSync(launch.tmux, ['-S', launch.socket, 'kill-server'], { encoding: 'utf8', timeout: 10000 })
        side.cleanup = { status: stopped.status, error: stopped.error?.message }
      }
      await provider.close()
      writeJSON(join(root, 'result.json'), side)
    }
  }
  const assertions = assessBuiltinAcceptance(pair)
  const report = { evidence, pair, assertions }
  writeJSON(join(evidence, 'acceptance.json'), report)
  return report
}

export function cleanRun(cache, target, execute = spawnSync) {
  cache = realpathSync(cache)
  const id = isAbsolute(target) ? basename(target) : target
  const run = join(cache, 'runs', id)
  if (!/^r-[a-f0-9]{12}$/.test(id) || (isAbsolute(target) && resolve(target) !== run) || realpathSync(run) !== run || realpathSync(dirname(run)) !== dirname(run)) throw new Error('Not an owned run path')
  const markerPath = join(run, '.mods-test-lab.json')
  if (!lstatSync(markerPath).isFile() || lstatSync(markerPath).isSymbolicLink()) throw new Error('Missing ownership marker')
  const marker = json(markerPath)
  if (marker.owner !== OWNER || marker.cache !== cache || marker.id !== id || marker.uid !== process.getuid?.()) throw new Error('Not an owned run')
  const report = existsSync(join(run, 'run.json')) ? json(join(run, 'run.json')) : {}
  if (existsSync(join(run, 'SEALED')) || existsSync(join(cache, 'SEALED')) || marker.sealed || report.sealed) throw new Error('Sealed evidence cannot be cleaned')
  if (marker.launcherPid !== process.pid && marker.launcherPid) {
    try { process.kill(marker.launcherPid, 0); throw new Error('Run launcher is still active') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const socket = join(run, 'tmux.sock')
  if (existsSync(socket)) {
    if (lstatSync(socket).isSymbolicLink() || !lstatSync(socket).isSocket()) throw new Error('Not an owned tmux socket')
    const result = execute(report.tmux ?? 'tmux', ['-S', socket, 'list-panes', '-a', '-F', '#{pane_dead}'], { encoding: 'utf8', timeout: 5000 })
    if (result.error || (result.status !== 0 && !result.stderr?.startsWith(`no server running on ${socket}`))) throw new Error('Cannot establish stopped tmux state')
    if (result.status === 0) {
      if (!/^1(?:\n1)*\n?$/.test(result.stdout)) throw new Error('Active or unknown tmux panes; exit the run first')
      const killed = execute(report.tmux ?? 'tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8', timeout: 5000 })
      if (killed.error || killed.status !== 0) throw new Error('Could not stop owned tmux server')
    }
  } else if (report.serverPid) {
    try { process.kill(report.serverPid, 0); throw new Error('Owned server still alive without its socket') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  rmSync(run, { recursive: true })
  return { cleaned: run }
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.command === 'fetch-official') console.log(JSON.stringify(fetchOfficial(options.cache), null, 2))
    else if (options.command === 'check') {
      const report = check(options)
      if (report.scan !== 'passed' || report.preparation !== 'passed' || report.errors.length) process.exitCode = 1
    } else if (options.command === 'run') startRun(options)
    else if (options.command === 'run-builtin') startBuiltinRun(options)
    else if (options.command === 'accept-builtin') {
      const report = await acceptBuiltin(options)
      console.log(JSON.stringify(report, null, 2))
      if (Object.values(report.assertions).some(item => item.verdict !== 'passed')) process.exitCode = 1
    }
    else console.log(JSON.stringify(cleanRun(options.cache, options.target), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
