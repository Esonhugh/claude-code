import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { lock } from '../../utils/lockfile.js'
import { getPluginDataDir } from '../../utils/plugins/pluginDirectories.js'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createModHostOperations, type FsStat } from './hostOperations.js'
import {
  getPolicySettingsOrigin,
  getSettingsForSource,
  getSettingsWithErrors,
} from '../../utils/settings/settings.js'
import { getPlatform } from '../../utils/platform.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { acceptSettingsFile, releaseSettingsFile, resetSettingsCache, retainSettingsFile, setCachedSettingsForSource, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { clearMdmSettingsCache, setMdmSettingsCache } from '../../utils/settings/mdm/settings.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from '../../utils/settings/managedPath.js'
import { resetSyncCache, setEligibility, setSessionCache } from '../remoteManagedSettings/syncCacheState.js'

const LIMIT = 4 * 1024 * 1024
let root: string
let cwd: string
let controller: AbortController
let host: ReturnType<typeof createModHostOperations>
const envKeys = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
]
let savedEnv: (string | undefined)[]

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mod-host-operations-')))
  cwd = join(root, 'work')
  await mkdir(cwd)
  savedEnv = envKeys.map((key) => process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'config', 'plugins')
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = join(root, 'managed')
  getManagedFilePath.cache.set(undefined, join(root, 'managed'))
  getManagedSettingsDropInDir.cache.clear()
  delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  resetSettingsCache()
  clearMdmSettingsCache()
  resetSyncCache()
  controller = new AbortController()
  host = createModHostOperations({
    cwd: () => cwd,
    storageId: 'example@market',
    signal: controller.signal,
  })
})

afterEach(async () => {
  controller.abort()
  resetSettingsCache()
  clearMdmSettingsCache()
  resetSyncCache()
  getManagedFilePath.cache.clear()
  getManagedSettingsDropInDir.cache.clear()
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  })
  await rm(root, { recursive: true, force: true })
})

async function storedFile(): Promise<string> {
  const dir = getPluginDataDir('example@market')
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  expect(files).toHaveLength(1)
  return join(dir, files[0])
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true')
    await delay(10)
  }
}

function runWorker(script: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: import.meta.dir,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Worker exited ${code}: ${stderr}`)),
    )
  })
}

const workerModule = new URL('./hostOperations.ts', import.meta.url).href

test('basic host operations do not eagerly load the instruction and query services', async () => {
  await runWorker(`
    import {expect} from 'bun:test';
    import {createModHostOperations} from ${JSON.stringify(workerModule)};
    import {expandTilde} from ${JSON.stringify(new URL('../../utils/path.ts', import.meta.url).href)};
    import {getPluginsDirectory} from ${JSON.stringify(new URL('../../utils/plugins/pluginDirectories.ts', import.meta.url).href)};
    const original=process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR='~/plugins//cache/';
    expect(getPluginsDirectory()).toBe(process.env.HOME+'/plugins//cache/');
    expect(expandTilde('~')).toBe(process.env.HOME);
    expect(expandTilde('~other/plugins')).toBe('~other/plugins');
    expect(expandTilde('./plugins')).toBe('./plugins');
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR=original;
    const host=createModHostOperations({cwd:()=>${JSON.stringify(cwd)},storageId:'example@market',signal:new AbortController().signal});
    await host.store.set('cold-start',1);
    await host.fs.write('cold-start.txt','ready');
    expect(await host.store.get('cold-start')).toBe(1);
    expect(await host.fs.read('cold-start.txt',{as:'text'})).toBe('ready');
    expect(Object.keys(require.cache).filter(path=>path.endsWith('/src/utils/claudemd.ts')||path.endsWith('/src/query.ts'))).toEqual([]);
  `)
}, 15000)

test('session authorization keeps the credential in the host and injects it into host fetch', async () => {
  const requests: { url: string; init: RequestInit }[] = []
  const operations = createModHostOperations({
    cwd: () => cwd, storageId: 'http@test', signal: controller.signal,
    sessionId: () => 'session-a',
    firstPartyCredential: async () => ({ kind: 'bearer', secret: 'fake-host-only-token' }),
    httpFetch: async (url, init) => {
      requests.push({ url, init })
      return new Response('accepted', { status: 202, headers: { 'X-Fixture': 'host', 'Content-Type': 'text/plain;charset=utf-8' } })
    },
  })
  const authorization = await operations.session.authorize()
  expect(authorization).toEqual({ handle: expect.any(String), kind: 'bearer' })
  expect(JSON.stringify(authorization)).not.toContain('fake-host-only-token')
  expect(await operations.http.fetch('https://api.anthropic.com/fixture', {
    method: 'POST', body: 'payload', auth: authorization!.handle,
    headers: { authorization: 'plugin-override', 'X-Api-Key': 'plugin-key' },
  })).toEqual({ status: 202, ok: true, headers: { 'content-type': 'text/plain;charset=utf-8', 'x-fixture': 'host' }, text: 'accepted' })
  expect(requests).toHaveLength(1)
  expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe('Bearer fake-host-only-token')
  expect(new Headers(requests[0]!.init.headers).get('x-api-key')).toBeNull()
})

describe('settings.read', () => {
  test('maps every public source to accepted host data and clones the merged snapshot without filtering keys', async () => {
    const sources = ['user', 'project', 'local', 'flag', 'policy'] as const
    for (const source of sources) {
      const settings = { model: source, env: { FIXTURE: source }, apiKeyHelper: 'fixture-helper', hooks: {}, unknownFixtureKey: { source } }
      setCachedSettingsForSource(`${source}Settings`, settings)
      expect(await host.settings.read({ source })).toEqual(settings)
    }
    const merged = { model:'policy', permissions:{allow:['Read']}, env:{FIXTURE:'merged'} }
    setSessionSettingsCache({ settings:merged, errors:[] })
    const snapshot = await host.settings.read()
    expect(snapshot).toEqual(merged)
    ;(snapshot.permissions as {allow:string[]}).allow.push('Bash')
    expect(await host.settings.read({})).toEqual(merged)
    expect(await host.settings.read({source:undefined})).toEqual(merged)
    setCachedSettingsForSource('policySettings', { model:'updated' })
    expect(await host.settings.read({source:'policy'})).toEqual({model:'updated'})
  })

  test('returns an empty object for a missing source and rejects invalid arguments or revoked lifetime', async () => {
    setCachedSettingsForSource('policySettings', null)
    expect(await host.settings.read({source:'policy'})).toEqual({})
    for (const args of [null, [], '', 1, {source:null}, {source:1}, {source:'merged'}, {source:'policySettings'}, {source:'__proto__'}]) {
      await expect(host.settings.read(args as never)).rejects.toThrow(TypeError)
    }
    controller.abort()
    await expect(host.settings.read({source:'policy'})).rejects.toMatchObject({name:'AbortError'})
  })

  test('loads real settings files but retains pending disk changes until the host accepts them', async () => {
    const path = join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json')
    await mkdir(process.env.CLAUDE_CONFIG_DIR!, {recursive:true})
    await writeFile(path, JSON.stringify({model:'accepted-fixture',env:{FIXTURE:'accepted'}}))
    expect(getSettingsForSource('userSettings')?.model).toBe('accepted-fixture')
    retainSettingsFile(path)
    try {
      await writeFile(path, JSON.stringify({model:'pending-fixture',env:{FIXTURE:'pending'}}))
      resetSettingsCache()
      expect(await host.settings.read({source:'user'})).toEqual({model:'accepted-fixture',env:{FIXTURE:'accepted'}})
      expect(JSON.parse(await readFile(path,'utf8')).model).toBe('pending-fixture')
      acceptSettingsFile(path, {settings:{model:'pending-fixture',env:{FIXTURE:'pending'}},errors:[],identity:null})
      expect(await host.settings.read({source:'user'})).toEqual({model:'pending-fixture',env:{FIXTURE:'pending'}})
      expect(await readFile(path,'utf8')).toBe(JSON.stringify({model:'pending-fixture',env:{FIXTURE:'pending'}}))
    } finally { releaseSettingsFile(path) }
  })

  test('composes accepted managed tiers when the highest source opts into merge', async () => {
    setEligibility(true)
    setSessionCache({
      managedSourcesBehavior: 'merge',
      model: 'remote-model',
      env: { REMOTE: '1' },
      permissions: { allow: ['Remote'] },
    })
    setMdmSettingsCache(
      {
        settings: {
          model: 'mdm-model',
          env: { MDM: '1' },
          permissions: { allow: ['Mdm'] },
        },
        errors: [],
      },
      { settings: {}, errors: [] },
    )
    resetSettingsCache()

    expect(await host.settings.read({ source: 'policy' })).toEqual({
      model: 'remote-model',
      env: { REMOTE: '1', MDM: '1' },
      permissions: { allow: ['Mdm', 'Remote'] },
    })
  })

  test('merges MDM and managed file settings when the remote source only sets merge mode', async () => {
    const managed = join(root, 'managed')
    await mkdir(managed)
    await writeFile(
      join(managed, 'managed-settings.json'),
      JSON.stringify({ env: { FILE_FIXTURE: '1' } }),
    )
    setEligibility(true)
    setSessionCache({ managedSourcesBehavior: 'merge' })
    setMdmSettingsCache(
      { settings: { env: { MDM_FIXTURE: '1' } }, errors: [] },
      { settings: {}, errors: [] },
    )
    resetSettingsCache()

    expect(await host.settings.read({ source: 'policy' })).toEqual({
      env: { MDM_FIXTURE: '1', FILE_FIXTURE: '1' },
    })
  })

  for (const { label, remote, expectedEnv } of [
    {
      label: 'mode-only first-wins',
      remote: { managedSourcesBehavior: 'first-wins' },
      expectedEnv: { MDM_FIXTURE: '1' },
    },
    {
      label: 'explicit first-wins with settings',
      remote: {
        managedSourcesBehavior: 'first-wins',
        env: { REMOTE_FIXTURE: '1' },
      },
      expectedEnv: { REMOTE_FIXTURE: '1' },
    },
    {
      label: 'default first-wins with settings',
      remote: { env: { REMOTE_FIXTURE: '1' } },
      expectedEnv: { REMOTE_FIXTURE: '1' },
    },
  ] as const) {
    test(`does not let lower merge override higher ${label}`, async () => {
      const managed = join(root, 'managed')
      await mkdir(managed)
      await writeFile(
        join(managed, 'managed-settings.json'),
        JSON.stringify({ env: { FILE_FIXTURE: '1' } }),
      )
      setEligibility(true)
      setSessionCache(remote)
      setMdmSettingsCache(
        {
          settings: {
            managedSourcesBehavior: 'merge',
            env: { MDM_FIXTURE: '1' },
          },
          errors: [],
        },
        { settings: {}, errors: [] },
      )
      resetSettingsCache()

      const policy = await host.settings.read({ source: 'policy' })
      expect(policy.env).toEqual(expectedEnv)
    })
  }

  test('rejects invalid remote disk settings and consistently falls back across managed tiers', async () => {
    const config = process.env.CLAUDE_CONFIG_DIR!
    const managed = join(root, 'managed')
    await mkdir(config, { recursive: true })
    await mkdir(managed, { recursive: true })
    await writeFile(
      join(config, 'remote-settings.json'),
      JSON.stringify({ model: 42 }),
    )
    await writeFile(
      join(managed, 'managed-settings.json'),
      JSON.stringify({ model: 'file-model' }),
    )
    setEligibility(true)

    for (const fallback of [
      {
        label: 'mdm',
        mdm: { model: 'mdm-model' },
        file: { model: 'file-model' },
        hkcu: { model: 'hkcu-model' },
        model: 'mdm-model',
        origin: getPlatform() === 'macos' ? 'plist' : 'hklm',
      },
      {
        label: 'file',
        mdm: {},
        file: { model: 'file-model' },
        hkcu: { model: 'hkcu-model' },
        model: 'file-model',
        origin: 'file',
      },
      {
        label: 'hkcu',
        mdm: {},
        file: {},
        hkcu: { model: 'hkcu-model' },
        model: 'hkcu-model',
        origin: 'hkcu',
      },
    ] as const) {
      await writeFile(
        join(managed, 'managed-settings.json'),
        JSON.stringify(fallback.file),
      )
      setMdmSettingsCache(
        { settings: fallback.mdm, errors: [] },
        { settings: fallback.hkcu, errors: [] },
      )
      resetSyncCache()
      setEligibility(true)
      resetSettingsCache()

      expect(
        await host.settings.read({ source: 'policy' }),
        fallback.label,
      ).toEqual({ model: fallback.model })
      expect(getPolicySettingsOrigin(), fallback.label).toBe(fallback.origin)
      const merged = getSettingsWithErrors()
      expect(merged.settings.model, fallback.label).toBe(fallback.model)
      expect(
        merged.errors.some(
          (error) =>
            error.file === 'remote managed settings' &&
            error.path === 'model',
        ),
        fallback.label,
      ).toBe(true)
    }

    await writeFile(
      join(config, 'remote-settings.json'),
      JSON.stringify({
        managedSourcesBehavior: 'merge',
        model: 'remote-model',
        env: { REMOTE: '1' },
      }),
    )
    await writeFile(
      join(managed, 'managed-settings.json'),
      JSON.stringify({ env: { FILE: '1' } }),
    )
    setMdmSettingsCache(
      { settings: { env: { MDM: '1' } }, errors: [] },
      { settings: { env: { HKCU: '1' } }, errors: [] },
    )
    resetSyncCache()
    setEligibility(true)
    resetSettingsCache()

    expect(await host.settings.read({ source: 'policy' })).toEqual({
      model: 'remote-model',
      env: { HKCU: '1', FILE: '1', MDM: '1', REMOTE: '1' },
    })
    expect(getPolicySettingsOrigin()).toBe('remote')
    const recovered = getSettingsWithErrors()
    expect(recovered.settings).toMatchObject({
      model: 'remote-model',
      env: { HKCU: '1', FILE: '1', MDM: '1', REMOTE: '1' },
    })
    expect(
      recovered.errors.some(
        (error) => error.file === 'remote managed settings',
      ),
    ).toBe(false)
  })

  test('keeps lower managed tiers shadowed when merge is not enabled', async () => {
    setEligibility(true)
    setSessionCache({ model: 'remote-model' })
    setMdmSettingsCache(
      { settings: { model: 'mdm-model' }, errors: [] },
      { settings: {}, errors: [] },
    )
    resetSettingsCache()

    expect(await host.settings.read({ source: 'policy' })).toEqual({
      model: 'remote-model',
    })
  })
})

describe('store', () => {
  test('requires nonempty keys of at most 256 UTF-16 code units without changing existing data', async () => {
    await host.store.set('original', 1)
    const path = await storedFile()
    const original = await readFile(path, 'utf8')
    for (const key of ['', 'a'.repeat(257), '\u{1D11E}'.repeat(128) + 'a']) {
      await expect(host.store.get(key)).rejects.toThrow()
      await expect(host.store.set(key, 'invalid')).rejects.toThrow()
      await expect(host.store.delete(key)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(original)
    }
    for (const key of ['a'.repeat(256), '\u{1D11E}'.repeat(128), 'nul\0key']) {
      await host.store.set(key, 'valid')
      expect(await host.store.get(key)).toBe('valid')
      await host.store.delete(key)
      expect(await host.store.get(key)).toBeUndefined()
    }
    expect(await host.store.keys()).toEqual(['original'])
  })

  test('cross-process permission failure rejects without overwriting the old store and recovers', async () => {
    await host.store.set('original', 1)
    const path = await storedFile()
    const original = await readFile(path, 'utf8')
    await chmod(getPluginDataDir('example@market'), 0o500)
    try {
      await runWorker(`
        import {createModHostOperations} from ${JSON.stringify(workerModule)};
        const h=createModHostOperations({cwd:()=>${JSON.stringify(cwd)},storageId:'example@market',signal:new AbortController().signal});
        try{await h.store.set('failed',2);process.exitCode=2}catch(e){if(e.code!=='EACCES'&&e.code!=='EPERM')throw e}
      `)
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally {
      await chmod(getPluginDataDir('example@market'), 0o700)
    }
    await host.store.set('recovered', 3)
    expect(await host.store.keys()).toEqual(['original', 'recovered'])
  }, 10000)

  test('actual atomic replacement failure rejects, releases the lock and removes its temp file', async () => {
    await host.store.set('original', 1)
    const path = await storedFile()
    const backup = path + '.backup'
    const signalPath = join(root, 'rename-reached')
    const resumePath = join(root, 'continue-rename')
    const script = `
      import {createModHostOperations} from ${JSON.stringify(workerModule)};
      import {getFsImplementation} from ${JSON.stringify(new URL('../../utils/fsOperations.ts', import.meta.url).href)};
      import {access,writeFile} from 'node:fs/promises';
      const fs=getFsImplementation(); const mkdir=fs.mkdir.bind(fs);
      fs.mkdir=async (...args)=>{await mkdir(...args);await writeFile(${JSON.stringify(signalPath)},'ready');while(true){try{await access(${JSON.stringify(resumePath)});break}catch{await Bun.sleep(10)}}};
      const h=createModHostOperations({cwd:()=>${JSON.stringify(cwd)},storageId:'example@market',signal:new AbortController().signal});
      try{await h.store.set('failed',2);process.exitCode=2}catch(e){if(!['EISDIR','ENOTDIR','EEXIST','EPERM'].includes(e.code))throw e}
    `
    const worker = runWorker(script)
    const outcome = worker.then(
      () => undefined,
      (error) => error,
    )
    try {
      await waitFor(async () => {
        try {
          await stat(signalPath)
          return true
        } catch {
          return false
        }
      })
      await rename(path, backup)
      await mkdir(path)
      await writeFile(resumePath, 'go')
      const error = await outcome
      if (error) throw error
      expect(
        (await readdir(getPluginDataDir('example@market'))).filter(
          (name) => name.includes('.tmp.') || name.endsWith('.lock'),
        ),
      ).toEqual([])
    } finally {
      await writeFile(resumePath, 'go')
      await outcome
      if (await host.fs.exists(backup)) {
        await rm(path, { recursive: true, force: true })
        await rename(backup, path)
      }
    }
    expect(await host.store.keys()).toEqual(['original'])
    await host.store.set('recovered', 3)
    expect(await host.store.get('recovered')).toBe(3)
  }, 10000)

  test('normalizes JSON values without retaining shared references', async () => {
    const value = {
      date: new Date('2026-01-01T00:00:00Z'),
      undef: undefined,
      array: [undefined],
      map: new Map(),
      set: new Set(),
      nested: { n: 1 },
    }
    await host.store.set('json', value)
    value.nested.n = 2
    const stored = await host.store.get('json')
    expect(stored).toEqual({
      date: '2026-01-01T00:00:00.000Z',
      array: [null],
      map: {},
      set: {},
      nested: { n: 1 },
    })
    ;(stored as typeof value).nested.n = 3
    expect(((await host.store.get('json')) as typeof value).nested.n).toBe(1)
    await expect(host.store.get(1 as never)).rejects.toThrow(TypeError)
    await expect(host.store.set(1 as never, 1)).rejects.toThrow(TypeError)
    await expect(host.store.delete(1 as never)).rejects.toThrow(TypeError)
  })

  test('isolates full canonical identities even when directory sanitizers collide', async () => {
    const a = 'example@market'
    const b = 'example/market'
    const other = createModHostOperations({
      cwd: () => cwd,
      storageId: b,
      signal: controller.signal,
    })
    await host.store.set('same', 'first')
    await other.store.set('same', 'second')
    expect(getPluginDataDir(a)).toBe(getPluginDataDir(b))
    expect(await host.store.get('same')).toBe('first')
    expect(await other.store.get('same')).toBe('second')
    const names = await readdir(getPluginDataDir(a))
    for (const id of [a, b])
      expect(
        names.some((name) =>
          name.includes(createHash('sha256').update(id).digest('hex')),
        ),
      ).toBe(true)
  })

  test('enforces the official total JSON character limit including keys, not UTF-8 bytes or local file encoding', async () => {
    const overhead = JSON.stringify({big: ''}).length
    for (const character of ['a', 'é', '界', '\u{1D11E}']) {
      const value = character.repeat(Math.floor((LIMIT - overhead) / character.length)) +
        'a'.repeat((LIMIT - overhead) % character.length)
      expect(JSON.stringify({big: value}).length).toBe(LIMIT)
      await host.store.set('big', value)
      expect(await host.store.get('big')).toBe(value)
      await expect(host.store.set('another', 1)).rejects.toThrow('4194304 characters')
      await expect(host.store.set('big', value + 'a')).rejects.toThrow('4194304 characters')
      expect(await host.store.get('big')).toBe(value)
      expect(await host.store.keys()).toEqual(['big'])
    }
    await host.store.delete('big')
    await host.store.set('recovered', true)
    expect(await host.store.get('recovered')).toBe(true)
  })

  test('rejects corrupt, duplicate, malformed and oversized stores without replacing them', async () => {
    await host.store.set('key', 1)
    const path = await storedFile()
    for (const text of [
      '{broken',
      '{}',
      '[["a",1],["a",2]]',
      '[[1,2]]',
      '[["a"]]',
      ' '.repeat(LIMIT + 1),
    ]) {
      await writeFile(path, text)
      await expect(host.store.get('key')).rejects.toThrow()
      await expect(host.store.keys()).rejects.toThrow()
      await expect(host.store.set('key', 2)).rejects.toThrow()
      await expect(host.store.delete('key')).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(text)
    }
  })

  test('deleting an absent key does not replace the existing store file', async () => {
    await host.store.set('original', 1)
    const path = await storedFile()
    const before = await stat(path)
    await host.store.delete('absent')
    const after = await stat(path)
    expect({ino:after.ino,mtimeMs:after.mtimeMs}).toEqual({ino:before.ino,mtimeMs:before.mtimeMs})
    expect(await host.store.get('original')).toBe(1)
  })

  test('concurrent callers and independent processes do not lose updates', async () => {
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => host.store.set(`local-${i}`, i)),
    )
    await Promise.all(
      Array.from({ length: 4 }, (_, worker) =>
        runWorker(`
      import {createModHostOperations} from ${JSON.stringify(workerModule)};
      const h = createModHostOperations({cwd:()=>${JSON.stringify(cwd)}, storageId:'example@market', signal:new AbortController().signal});
      for(let i=0;i<12;i++) await h.store.set('worker-${worker}-'+i,i);
    `),
      ),
    )
    const keys = await host.store.keys()
    expect(keys).toHaveLength(64)
    for (let worker = 0; worker < 4; worker++)
      for (let i = 0; i < 12; i++)
        expect(await host.store.get(`worker-${worker}-${i}`)).toBe(i)
  }, 15000)

  test('lock wait is abortable and failed writes do not leak the lock', async () => {
    await host.store.set('original', 1)
    const path = await storedFile()
    const release = await lock(path, { realpath: false })
    try {
      const pending = host.store.set('cancelled', 2)
      const timer = setTimeout(() => controller.abort(), 30)
      try {
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        clearTimeout(timer)
      }
    } finally {
      await release()
    }
    const again = createModHostOperations({
      cwd: () => cwd,
      storageId: 'example@market',
      signal: new AbortController().signal,
    })
    expect(await again.store.keys()).toEqual(['original'])
    await rm(path)
    await mkdir(path)
    await expect(again.store.set('failed', 1)).rejects.toThrow()
    await rm(path, { recursive: true })
    await again.store.set('restored', 3)
    expect(await again.store.get('restored')).toBe(3)
    expect(
      (await readdir(getPluginDataDir('example@market'))).filter(
        (name) => name.includes('.tmp.') || name.endsWith('.lock'),
      ),
    ).toEqual([])
  })

  test('cross-process cancellation waiting for another process lock leaves no mutation', async () => {
    await host.store.set('original', 1)
    const path = await storedFile()
    const release = await lock(path, { realpath: false })
    try {
      await runWorker(`
        import {createModHostOperations} from ${JSON.stringify(workerModule)};
        const c=new AbortController(); const h=createModHostOperations({cwd:()=>${JSON.stringify(cwd)},storageId:'example@market',signal:c.signal});
        const pending=h.store.set('cancelled',2); setTimeout(()=>c.abort(),50);
        try{await pending;process.exitCode=2}catch(e){if(e.name!=='AbortError')throw e}
      `)
    } finally {
      await release()
    }
    expect(await host.store.keys()).toEqual(['original'])
  }, 10000)

  test('uses JSON omission for nested functions and rejects non-JSON root values without mutation', async () => {
    await host.store.set('nested', { missing: () => 1, array: [() => 1], kept: true })
    expect(await host.store.get('nested')).toEqual({ array: [null], kept: true })
    await host.store.set('value', 'original')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [
      () => 1,
      cycle,
      undefined,
      1n,
    ]) {
      await expect(host.store.set('value', value)).rejects.toThrow()
      expect(await host.store.get('value')).toBe('original')
    }
  })

  test('persists insertion order across reloads, overwrites and reinserts without prototype key collisions', async () => {
    expect(await host.store.get('missing')).toBeUndefined()
    expect(await host.store.keys()).toEqual([])
    for (const key of ['10', '2', '__proto__', 'constructor'])
      await host.store.set(key, { key })
    await host.store.set('10', 'updated')
    const again = createModHostOperations({
      cwd: () => root,
      storageId: 'example@market',
      signal: controller.signal,
    })
    expect(await again.store.keys()).toEqual([
      '10',
      '2',
      '__proto__',
      'constructor',
    ])
    expect(await again.store.get('__proto__')).toEqual({ key: '__proto__' })
    expect(await again.store.get('10')).toBe('updated')
    await again.store.delete('2')
    await again.store.delete('absent')
    await again.store.set('2', 2)
    const expected = ['10', '__proto__', 'constructor', '2']
    expect(await host.store.keys()).toEqual(expected)
    const reloaded = createModHostOperations({
      cwd: () => cwd,
      storageId: 'example@market',
      signal: controller.signal,
    })
    expect(await reloaded.store.keys()).toEqual(expected)
    expect(await reloaded.store.get('2')).toBe(2)
  })
})

describe('process.run', () => {
  test('rejects null timeout instead of treating it as the default', async () => {
    await expect(
      host.process.run([process.execPath, '-e', ''], {
        timeoutMs: null as never,
      }),
    ).rejects.toThrow()
  })

  test('does not exceed the output byte cap when truncating a multibyte character', async () => {
    const result = await host.process.run([
      process.execPath,
      '-e',
      `import {writeSync} from 'node:fs'; writeSync(1,'a'.repeat(${LIMIT - 1})+'é'); writeSync(2,'b'.repeat(${LIMIT - 1})+'é')`,
    ])
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(LIMIT)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(LIMIT)
    expect(result.stdout.endsWith('�')).toBe(false)
  })

  test('Git invocations disable repository hooks', async () => {
    const result = await host.process.run([
      'git',
      'config',
      '--get',
      'core.hooksPath',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(
      process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null',
    )
  })

  for (const mode of ['abort', 'timeout'] as const) {
    for (const parentExits of [false, true]) {
      test(`${mode} kills descendants even if parent ${parentExits ? 'has exited while pipes remain open' : 'is alive'}`, async () => {
        const ready = join(root, 'ready.json')
        const descendant = `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid})); setTimeout(()=>{},10000)`
        const parent = `import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']}); console.log(process.pid); ${parentExits ? 'setTimeout(()=>process.exit(0),100)' : "process.on('SIGTERM',()=>{});setTimeout(()=>{},10000)"}`
        const pending = host.process.run([process.execPath, '-e', parent], {
          timeoutMs: mode === 'timeout' ? 750 : 5000,
        })
        const settled = pending.then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        )
        let pid: number | undefined
        try {
          await waitFor(async () => {
            try {
              pid = JSON.parse(await readFile(ready, 'utf8')).pid
              return true
            } catch {
              return false
            }
          })
          if (parentExits) await delay(200)
          if (mode === 'abort') controller.abort()
          const result = await settled
          expect(result.error).toMatchObject({
            name: mode === 'abort' ? 'AbortError' : 'TimeoutError',
          })
          expect(result.value).toBeUndefined()
          await waitFor(async () => {
            try {
              process.kill(pid!, 0)
              return false
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH'
            }
          })
        } finally {
          controller.abort()
          await settled
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              // The process already exited.
            }
          }
        }
      }, 10000)
    }
  }

  test('signal death returns 1; closed stdin does not hide the exit result', async () => {
    const killed = await host.process.run([
      process.execPath,
      '-e',
      'process.kill(process.pid,"SIGKILL")',
    ])
    expect(killed.exitCode).toBe(1)
    const result = await host.process.run(
      [process.execPath, '-e', 'process.exit(3)'],
      { stdin: 'x'.repeat(LIMIT * 2) },
    )
    expect(result.exitCode).toBe(3)
  })

  test('validates init and timeout before launching', async () => {
    const argv = [process.execPath, '-e', '']
    for (const init of [
      null,
      [],
      1,
      { cwd: 1 },
      { cwd: '' },
      { cwd: 'a\0b' },
      { env: [] },
      { env: { A: 1 } },
      { env: { 'A=B': 'x' } },
      { env: { A: 'x\0y' } },
      { stdin: 1 },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: 600001 },
      { timeoutMs: 1000.5 },
      { timeoutMs: NaN },
      { timeoutMs: Infinity },
    ]) {
      await expect(host.process.run(argv, init as never)).rejects.toThrow()
    }
    for (const invalid of [
      [],
      '',
      [1],
      [''],
      [process.execPath, null],
      [process.execPath, 'a\0b'],
    ]) {
      await expect(host.process.run(invalid as never)).rejects.toThrow()
    }
    expect((await host.process.run(argv, { timeoutMs: 600000 })).exitCode).toBe(
      0,
    )
  })

  test('spawn failure preserves errno and pre-abort starts no process', async () => {
    await expect(
      host.process.run([join(root, 'not-an-executable')]),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      host.process.run([process.execPath, '-e', ''], { cwd: 'missing' }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    controller.abort()
    await expect(
      host.process.run([
        process.execPath,
        '-e',
        `require('fs').writeFileSync('started','yes')`,
      ]),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(cwd)).toEqual([])
  })

  test('timeout rejects instead of converting termination into exitCode 1', async () => {
    await expect(
      host.process.run([process.execPath, '-e', 'setTimeout(() => {}, 250)'], {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  test('in-flight abort rejects distinctly', async () => {
    const pending = host.process.run([
      process.execPath,
      '-e',
      'setTimeout(() => {}, 250)',
    ])
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('caps stdout and stderr independently while draining past the cap', async () => {
    const script = `import {writeSync} from 'node:fs'; const b = Buffer.alloc(65536, 'x'); for(let i=0;i<80;i++){writeSync(1,b);writeSync(2,b)}; process.exitCode=9`
    const result = await host.process.run([process.execPath, '-e', script])
    expect(result.exitCode).toBe(9)
    expect(Buffer.byteLength(result.stdout)).toBe(LIMIT)
    expect(Buffer.byteLength(result.stderr)).toBe(LIMIT)
  })

  test('passes literal argv, cwd, env and stdin without a shell; returns nonzero output', async () => {
    await mkdir(join(cwd, 'child'))
    const script = `const input = await Bun.stdin.text(); console.log(JSON.stringify({args:process.argv.slice(1), cwd:process.cwd(), env:process.env.MOD_TEST, input})); console.error('failure'); process.exitCode = 7`
    const args = ['$(touch injected)', '; echo not-a-shell', 'a b']
    const result = await host.process.run(
      [process.execPath, '-e', script, ...args],
      {
        cwd: 'child',
        env: { MOD_TEST: 'value' },
        stdin: '你好\n',
      },
    )
    expect(result.exitCode).toBe(7)
    expect(result.stderr).toBe('failure\n')
    expect(JSON.parse(result.stdout)).toEqual({
      args,
      cwd: join(cwd, 'child'),
      env: 'value',
      input: '你好\n',
    })
    expect(await host.fs.exists('child/injected')).toBe(false)
  })
})

describe('fs.ancestors', () => {
  test('skips absent and non-instruction entries, preserves CRLF and spelling, and rereads disk on each call', async () => {
    const name = `${basename(root)}.md`
    const path = join(cwd, name)
    const request = { names: [`./${name}`], below: root }
    expect(await host.fs.ancestors(request)).toEqual([])
    await mkdir(path)
    expect(await host.fs.ancestors(request)).toEqual([])
    await rm(path, { recursive: true })
    for (const content of ['', ' \n\t', '<!-- only a comment -->']) {
      await writeFile(path, content)
      expect(await host.fs.ancestors(request)).toEqual([])
    }
    for (const content of ['# First\r\n\r\nText\r\n', '# Updated\n']) {
      await writeFile(path, content)
      expect(await host.fs.ancestors(request)).toEqual([
        { dir: cwd, name: `./${name}`, content, parts: [{ path, content }] },
      ])
    }
    for (const request of [{ names: [name], below: root }, { names: [] }]) {
      const reason = new Error('cancel before walking')
      await expect(host.fs.ancestors(request, AbortSignal.abort(reason))).rejects.toBe(reason)
    }
    controller.abort()
    await expect(host.fs.ancestors(request, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('keeps the memory loader include-depth bound', async () => {
    const name = `${basename(root)}.md`
    await writeFile(join(cwd, name), 'root\n@./level-1.md')
    for (let level = 1; level <= 6; level++) {
      await writeFile(join(cwd, `level-${level}.md`), `level ${level}\n@./level-${level + 1}.md`)
    }
    const found = await host.fs.ancestors({ names: [name], below: root })
    expect(found[0].parts.map(part => part.path)).toEqual([
      join(cwd, name), ...[1, 2, 3, 4].map(level => join(cwd, `level-${level}.md`)),
    ])
  })

  for (const lifetime of ['invocation', 'activation'] as const) {
    test(`cancels a pending memory read on ${lifetime} abort without waiting for the reader`, async () => {
      const name = `${basename(root)}.md`
      const path = join(cwd, name)
      await writeFile(path, 'fixture')
      const request = { names: [name], below: root }
      const invocation = new AbortController()
      const reason = new Error(`cancel ${lifetime}`)
      const fs = getFsImplementation()
      const read = fs.readFile.bind(fs)
      let reached!: () => void
      const started = new Promise<void>(resolve => { reached = resolve })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let finish!: () => void
      const finished = new Promise<void>(resolve => { finish = resolve })
      const reader = spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
        if (file !== path) return read(file, options)
        reached()
        await gate
        try {
          return await read(file, options)
        } finally {
          finish()
        }
      })
      let pending: Promise<readonly unknown[]> | undefined
      try {
        pending = host.fs.ancestors(request, invocation.signal)
        await started
        if (lifetime === 'activation') controller.abort(reason)
        else invocation.abort(reason)
        const outcome = await Promise.race([
          pending.then(() => 'resolved', error => error),
          delay(100).then(() => 'still waiting'),
        ])
        expect(outcome).toBe(reason)
      } finally {
        release()
        await finished
        await pending?.catch(() => {})
        reader.mockRestore()
      }
      if (lifetime === 'invocation') {
        expect(controller.signal.aborted).toBe(false)
        expect((await host.fs.ancestors(request))[0].content).toBe('fixture')
      }
    })
  }

  test('enforces the raw-byte read budget for roots, stripped content and imported parts', async () => {
    const name = `${basename(root)}.md`
    const path = join(cwd, name)
    const request = { names: [name], below: root }
    const text = 'é'.repeat(LIMIT / 2)
    await writeFile(path, text)
    expect((await host.fs.ancestors(request))[0].content).toBe(text)
    await writeFile(path, text + 'x')
    await expect(host.fs.ancestors(request)).rejects.toThrow('4 MiB')
    await writeFile(path, '<!--' + 'x'.repeat(LIMIT) + '-->\nsmall')
    await expect(host.fs.ancestors(request)).rejects.toThrow('4 MiB')
    await writeFile(path, '@./large.txt')
    await writeFile(join(cwd, 'large.txt'), text)
    await expect(host.fs.ancestors(request)).rejects.toThrow('4 MiB')
    await writeFile(join(cwd, 'large.txt'), '<!--' + 'x'.repeat(LIMIT) + '-->\nsmall')
    await expect(host.fs.ancestors(request)).rejects.toThrow('4 MiB')
    await writeFile(join(cwd, 'large.txt'), 'recovered')
    expect((await host.fs.ancestors(request))[0].parts.map(part => part.content)).toEqual(['@./large.txt', 'recovered'])
  })

  test('uses memory markdown semantics, parent-first parts and lexical path identity without global memory filtering', async () => {
    const name = `${basename(root)}.md`
    const target = join(root, 'external')
    await mkdir(target)
    const main = join(cwd, name)
    const child = join(target, 'child.md')
    const grandchild = join(target, 'grandchild.txt')
    const other = join(target, 'other file.md')
    const mainText = '# Main\n\n@./child.md#section\n@./other\\ file.md\n@./child.md\n\n`@./ignored.md`\n\n```md\n@./ignored.md\n```\n'
    const childText = '# Child\n\n@./grandchild.txt\n@./entry.md\n@./binary.png\n@./missing.md\n'
    await writeFile(join(target, 'entry.md'), '---\npaths: ["never-match/**"]\n---\n<!-- @./ignored.md -->\n' + mainText)
    await writeFile(child, childText)
    await writeFile(grandchild, 'grandchild')
    await writeFile(other, 'other')
    await writeFile(join(target, 'ignored.md'), 'must not load')
    await writeFile(join(target, 'binary.png'), 'not text')
    await symlink(join(target, 'entry.md'), main)
    setSessionSettingsCache({ settings: { claudeMdExcludes: ['**/*.md'] }, errors: [] })
    const parts = [
      { path: main, content: mainText },
      { path: child, content: childText },
      { path: grandchild, content: 'grandchild' },
      { path: other, content: 'other' },
    ]
    expect(await host.fs.ancestors({ names: [name], below: root })).toEqual([
      { dir: cwd, name, parts, content: parts.map(part => part.content).join('\n\n') },
    ])
    // An include shared by separately requested roots still belongs to each entry.
    const secondName = `${basename(root)}-second.md`
    const secondText = `Second\n@${other.replaceAll(' ', '\\ ')}`
    await writeFile(join(cwd, secondName), secondText)
    const again = await host.fs.ancestors({ names: [name, secondName], below: root })
    expect(again).toHaveLength(2)
    expect(again[1].parts).toEqual([
      { path: join(cwd, secondName), content: secondText },
      { path: other, content: 'other' },
    ])
  })

  test('rejects malformed requests and non-relative markdown names before walking', async () => {
    const guarded = createModHostOperations({
      cwd: () => { throw new Error('must validate before walking') },
      storageId: 'ancestors-validation@test',
      signal: controller.signal,
    })
    for (const request of [
      undefined, null, [], 'file.md', {}, { names: 'file.md' }, { names: [null] },
      ...['', '.', '..', '../file.md', 'dir/../file.md', 'dir\\..\\file.md', '/file.md',
        '//server/file.md', 'C:\\file.md', 'C:file.md', '\\file.md', 'file.txt', 'file.md\0'].map(name => ({ names: [name] })),
      ...[null, 1, '', 'bad\0file', '//server/file', '\\\\server\\file'].flatMap(path => [
        { names: ['fixture.md'], of: path },
        { names: ['fixture.md'], below: path },
      ]),
    ]) {
      await expect(guarded.fs.ancestors(request as never)).rejects.toThrow(TypeError)
    }
  })

  test('resolves of and below against current cwd, excludes below itself and ignores sibling prefixes', async () => {
    const name = `${basename(root)}.md`
    const project = join(root, 'project')
    const nested = join(project, 'nested')
    const deep = join(nested, 'deep')
    const sibling = join(root, 'project-other')
    for (const dir of [project, nested, deep, sibling]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), dir)
    }
    const request = { names: [name], of: '../project/nested/deep/not-created.ts', below: '../project' }
    const found = await host.fs.ancestors(request)
    expect(found.map(entry => entry.dir)).toEqual([nested, deep])
    expect(await host.fs.ancestors({ ...request, of: join(deep, 'file.ts'), below: project })).toEqual(found)
    for (const of of [join(project, 'file.ts'), join(sibling, 'file.ts'), join(root, 'file.ts')]) {
      expect(await host.fs.ancestors({ ...request, of })).toEqual([])
    }
    expect((await host.fs.ancestors({ names: [name], of: request.of })).map(entry => entry.dir)).toEqual([project, nested, deep])
    expect((await host.fs.ancestors({ names: [name], below: root })).map(entry => entry.dir)).toEqual([])
    expect(await host.fs.ancestors({ names: [], of: request.of })).toEqual([])
  })

  test('walks to the original session root, root first, preserving requested names and per-directory order', async () => {
    const name = `${basename(root)}.md`
    const hiddenName = `.claude/${name}`
    const sessionRoot = join(cwd, 'project')
    await mkdir(join(sessionRoot, '.claude'), { recursive: true })
    await writeFile(join(root, name), 'outer')
    await writeFile(join(cwd, name), 'work')
    await writeFile(join(sessionRoot, name), 'project')
    await writeFile(join(sessionRoot, hiddenName), 'hidden')
    const session = createModHostOperations({
      cwd: () => cwd,
      root: () => sessionRoot,
      storageId: 'ancestors@test',
      signal: controller.signal,
    })
    const expected = [
      { dir: root, name, content: 'outer' },
      { dir: cwd, name, content: 'work' },
      { dir: sessionRoot, name: hiddenName, content: 'hidden' },
      { dir: sessionRoot, name, content: 'project' },
    ].map(entry => ({
      ...entry,
      parts: [{ path: join(entry.dir, entry.name), content: entry.content }],
    }))
    expect(await session.fs.ancestors({ names: [hiddenName, name] })).toEqual(expected)
    cwd = join(root, 'elsewhere')
    await mkdir(cwd)
    await writeFile(join(cwd, name), 'not the original root')
    expect(await session.fs.ancestors({ names: [hiddenName, name] })).toEqual(expected)
  })
})

describe('fs', () => {
  test('reads non-UTF8 and empty bytes as base64 without changing default or explicit text reads', async () => {
    const bytes = Buffer.from([0, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x61])
    await writeFile(join(cwd, 'binary'), bytes)
    expect(await host.fs.read('binary', { as: 'bytes' })).toEqual({
      base64: bytes.toString('base64'),
    })
    expect(await host.fs.read('binary')).toBe(bytes.toString('utf8'))
    expect(await host.fs.read('binary', { as: 'text' })).toBe(bytes.toString('utf8'))
    await writeFile(join(cwd, 'empty'), '')
    expect(await host.fs.read('empty', { as: 'bytes' })).toEqual({ base64: '' })
    expect(await host.fs.read('empty', { as: 'text' })).toBe('')
  })

  test('rejects invalid read options at the host boundary', async () => {
    await writeFile(join(cwd, 'file'), 'text')
    for (const options of [null, [], 'bytes', 1, {}, { as: undefined }, { as: null }, { as: 'binary' }, { as: true }]) {
      await expect(host.fs.read('file', options as never)).rejects.toThrow(TypeError)
    }
  })

  test.skipIf(process.platform === 'win32')('reads an unwritten FIFO without waiting for a writer', async () => {
    const path = join(cwd, 'empty-fifo')
    const fifo = Bun.spawn(['mkfifo', path], { stdout: 'pipe', stderr: 'pipe' })
    expect(await fifo.exited).toBe(0)
    const child = Bun.spawn([process.execPath, '-e', `
      import {createModHostOperations} from ${JSON.stringify(workerModule)};
      const host = createModHostOperations({cwd:()=>${JSON.stringify(cwd)}, storageId:'fifo@test', signal:new AbortController().signal});
      const text = await host.fs.read('empty-fifo');
      if (text !== '') throw new Error('Expected empty FIFO content');
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  }, 10000)

  for (const operation of ['read', 'write', 'list', 'exists', 'stat'] as const) {
    test(`${operation} rejects network path spellings before resolving cwd or touching the filesystem`, async () => {
      const guarded = createModHostOperations({
        cwd: () => { throw new Error('cwd must not be read') },
        storageId: 'network@test',
        signal: controller.signal,
      })
      for (const path of [
        '//server/share',
        String.raw`\\server\share`,
        String.raw`/\server/share`,
        String.raw`\/server/share`,
        String.raw`\\?\UNC\server\share`,
      ]) {
        const pending = operation === 'write'
          ? guarded.fs.write(path, 'unchanged')
          : guarded.fs[operation](path)
        await expect(pending).rejects.toThrow(/network/i)
      }
    })
  }

  test('validates exists input and respects revoked lifetime before observing the filesystem', async () => {
    for (const path of [null, '']) {
      await expect(host.fs.exists(path as unknown as string)).rejects.toThrow(TypeError)
    }
    expect(await host.fs.exists('bad\0path')).toBe(false)
    for (const operation of [host.fs.read, host.fs.list, host.fs.stat]) {
      await expect(operation('')).rejects.toThrow(TypeError)
    }
    controller.abort()
    await expect(host.fs.exists('missing')).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('cancels only the filesystem invocation without revoking its activation', async () => {
    const aborted = AbortSignal.abort()
    for (const operation of [
      () => host.fs.read('file', undefined, aborted),
      () => host.fs.read('file', { as: 'bytes' }, aborted),
      () => host.fs.list('.', aborted),
      () => host.fs.stat('file', undefined, aborted),
      () => host.fs.stat('file', { resolve: true }, aborted),
      () => host.fs.exists('file', aborted),
      () => host.fs.write('file', 'cancelled', aborted),
    ]) {
      await expect(operation()).rejects.toMatchObject({ name: 'AbortError' })
    }
    expect(controller.signal.aborted).toBe(false)
    expect(await host.fs.exists('file')).toBe(false)
    await host.fs.write('file', 'active')
    expect(await host.fs.read('file')).toBe('active')
  })

  test('preserves missing errno and exists maps filesystem errors to false', async () => {
    for (const operation of [host.fs.read, host.fs.stat, host.fs.list]) {
      await expect(operation('missing')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
    await host.fs.write('file', 'x')
    await expect(host.fs.write('file/child', 'x')).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })

  test('allows absolute paths and limits write bytes before changing files', async () => {
    const target = join(root, 'absolute')
    const text = 'é'.repeat(LIMIT / 2)
    await host.fs.write(target, text)
    expect(await host.fs.read(target)).toBe(text)
    await expect(host.fs.write(target, text + 'x')).rejects.toThrow('4 MiB')
    expect(await readFile(target, 'utf8')).toBe(text)
    await expect(
      host.fs.write('not-created/large', text + 'x'),
    ).rejects.toThrow('4 MiB')
    expect(await host.fs.exists('not-created')).toBe(false)
    await expect(host.fs.write('bad', 3 as unknown as string)).rejects.toThrow(
      TypeError,
    )
  })

  test('lists links without following them and includes isLink on every entry', async () => {
    await host.fs.write('file', 'abc')
    await mkdir(join(cwd, 'dir'))
    await symlink('file', join(cwd, 'link'))
    await symlink('dir', join(cwd, 'dir-link'))
    await symlink('missing', join(cwd, 'broken'))
    expect(await host.fs.list()).toEqual([
      { name: 'broken', kind: 'other', size: 0, isLink: true },
      { name: 'dir', kind: 'dir', size: 0, isLink: false },
      { name: 'dir-link', kind: 'other', size: 0, isLink: true },
      { name: 'file', kind: 'file', size: 3, isLink: false },
      { name: 'link', kind: 'other', size: 0, isLink: true },
    ])
  })

  test('stats link targets, resolves only when requested and keeps dangling link metadata', async () => {
    await host.fs.write('dir/file', 'abc')
    await link(join(cwd, 'dir/file'), join(cwd, 'hard'))
    await symlink('dir/file', join(cwd, 'link'))
    await symlink('link', join(cwd, 'chain'))
    await symlink('dir', join(cwd, 'dir-link'))
    await symlink('missing', join(cwd, 'broken'))
    await symlink('dir/file/child', join(cwd, 'broken-parent'))
    for (const [path, target, isLink] of [
      ['dir/file', 'dir/file', false],
      ['hard', 'hard', false],
      ['link', 'dir/file', true],
      ['chain', 'dir/file', true],
      ['dir-link', 'dir', true],
      ['dir-link/./file', 'dir/file', false],
      ['.', '.', false],
    ] as const) {
      const info = await stat(join(cwd, target))
      const expected: FsStat = {
        kind: info.isDirectory() ? 'dir' : 'file',
        size: info.size,
        mtimeMs: info.mtimeMs,
        isLink,
      }
      expect(await host.fs.stat(path)).toEqual(expected)
      expect(await host.fs.stat(path, { resolve: false })).toEqual(expected)
      expect(await host.fs.stat(path, { resolve: true })).toEqual({
        ...expected,
        realPath: await realpath(join(cwd, target)),
      })
    }
    for (const path of ['broken', 'broken-parent']) {
      const info = await lstat(join(cwd, path))
      const expected: FsStat = { kind: 'other', size: info.size, mtimeMs: info.mtimeMs, isLink: true }
      expect(await host.fs.stat(path)).toEqual(expected)
      expect(await host.fs.stat(path, { resolve: true })).toEqual(expected)
      expect(await host.fs.exists(path)).toBe(false)
    }
    await expect(host.fs.stat('missing', { resolve: true })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects invalid stat options at the host boundary', async () => {
    await writeFile(join(cwd, 'file'), 'text')
    for (const options of [null, [], true, 1, {}, { resolve: undefined }, { resolve: null }, { resolve: 'true' }, { resolve: 1 }]) {
      await expect(host.fs.stat('file', options as never)).rejects.toThrow(TypeError)
    }
  })

  test('writes with parent creation and lists sorted file metadata', async () => {
    await host.fs.write('nested/z', 'é')
    await host.fs.write('nested/a', 'hello')
    await mkdir(join(cwd, 'nested', 'dir'))
    expect(await host.fs.list('nested')).toEqual([
      { name: 'a', kind: 'file', size: 5, isLink: false },
      { name: 'dir', kind: 'dir', size: 0, isLink: false },
      { name: 'z', kind: 'file', size: 2, isLink: false },
    ])
    expect(await host.fs.stat('nested/z')).toEqual({
      kind: 'file',
      size: 2,
      mtimeMs: (await stat(join(cwd, 'nested/z'))).mtimeMs,
      isLink: false,
    })
    expect(await host.fs.exists('nested/z')).toBe(true)
    expect(await host.fs.exists('absent')).toBe(false)
    expect(await host.fs.list()).toEqual([
      { name: 'nested', kind: 'dir', size: 0, isLink: false },
    ])
  })

  test('reads UTF-8 relative to the current session cwd', async () => {
    await writeFile(join(cwd, 'text'), '你好\n')
    expect(await host.fs.read('text')).toBe('你好\n')
    cwd = root
    expect(await host.fs.read('work/text')).toBe('你好\n')
  })

  for (const as of ['text', 'bytes'] as const) {
    test(`bounds ${as} reads by raw bytes, allowing exactly 4 MiB`, async () => {
      const bytes = Buffer.from('é'.repeat(LIMIT / 2))
      await writeFile(join(cwd, 'large'), bytes)
      expect(await host.fs.read('large', { as })).toEqual(
        as === 'bytes' ? { base64: bytes.toString('base64') } : bytes.toString('utf8'),
      )
      await writeFile(join(cwd, 'large'), Buffer.concat([bytes, Buffer.from('x')]))
      await expect(host.fs.read('large', { as })).rejects.toThrow('4 MiB')
    })

    test(`cancels an in-flight ${as} read without revoking its activation`, async () => {
      await writeFile(join(cwd, 'large'), Buffer.alloc(LIMIT))
      const invocation = new AbortController()
      const reason = new Error('cancel this read')
      const pending = host.fs.read('large', { as }, invocation.signal)
      invocation.abort(reason)
      await expect(pending).rejects.toBe(reason)
      expect(controller.signal.aborted).toBe(false)
      await host.fs.write('small', 'still active')
      expect(await host.fs.read('small')).toBe('still active')
    })
  }

  test('uses the activation signal by default for read and stat', async () => {
    await host.fs.write('file', 'text')
    controller.abort()
    for (const pending of [
      host.fs.read('file'),
      host.fs.read('file', { as: 'bytes' }),
      host.fs.stat('file'),
      host.fs.stat('file', { resolve: true }),
    ]) {
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    }
  })

  test('allows parent-relative paths and links outside cwd without filesystem hooks', async () => {
    await host.fs.write('../outside/file', 'outside')
    await symlink(join(root, 'outside'), join(cwd, 'outside-link'))
    for (const path of ['../outside/file', join(root, 'outside/file'), 'outside-link/file']) {
      expect(await host.fs.read(path)).toBe('outside')
      expect(await host.fs.exists(path)).toBe(true)
      expect(await host.fs.stat(path, { resolve: true })).toMatchObject({
        kind: 'file', isLink: false, realPath: join(root, 'outside/file'),
      })
    }
    expect(await host.fs.list('../outside')).toEqual([
      { name: 'file', kind: 'file', size: 7, isLink: false },
    ])
    expect(await host.fs.stat('outside-link', { resolve: true })).toMatchObject({
      kind: 'dir', isLink: true, realPath: join(root, 'outside'),
    })
  })

  test('preserves OS refusal for cyclic links instead of treating them as dangling', async () => {
    await symlink('cycle', join(cwd, 'cycle'))
    await expect(host.fs.stat('cycle')).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(host.fs.stat('cycle', { resolve: true })).rejects.toMatchObject({ code: 'ELOOP' })
  })
})
