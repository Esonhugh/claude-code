import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Marketplace state lives under process-wide HOME/config paths, so the cases
// run in a child whose HOME, config dir and git config are owned by this test.
if (!process.env.MARKETPLACE_LIFECYCLE_TEST_CHILD) {
  test('marketplace refresh keeps clones and registry entries it does not own', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'mkt-lifecycle-')))
    try {
      // GitHub sources must never reach the network: ssh always fails and
      // github.com URLs are rewritten to local repositories.
      const bin = join(home, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 255\n')
      chmodSync(join(bin, 'ssh'), 0o755)
      const remotes = join(home, 'remotes')
      writeFileSync(
        join(home, '.gitconfig'),
        `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`,
      )
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: home,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          TMPDIR: home,
          CLAUDE_CONFIG_DIR: join(home, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          MARKETPLACE_LIFECYCLE_TEST_CHILD: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      console.log(stdout, stderr)
      expect(stderr).toMatch(/(?:^|\n) 5 pass(?:\n|$)/)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(root)
  const mm = await import('./marketplaceManager.js')

  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=a@b',
        '-c',
        'user.name=n',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, stdio: 'pipe' },
    )
  const makeRepo = (repo: string, name: string, plugins: string[]) => {
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(repo, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        name,
        owner: { name: 'x' },
        plugins: plugins.map(p => ({ name: p, source: `./${p}` })),
      }),
    )
    if (!existsSync(join(repo, '.git'))) git(repo, 'init', '-q')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', `plugins ${plugins.join(',')}`)
  }
  const knownFile = join(root, 'config/plugins/known_marketplaces.json')
  const readKnown = () => JSON.parse(readFileSync(knownFile, 'utf-8'))
  const pluginNames = async (name: string) => {
    mm.clearMarketplacesCache()
    return (await mm.getMarketplaceCacheOnly(name))?.plugins.map(p => p.name)
  }
  const cacheEntries = () =>
    readdirSync(mm.getMarketplacesCacheDir()).sort()

  const repo = join(root, 'repo')
  makeRepo(repo, 'gm', ['a'])
  await mm.addMarketplaceSource({ source: 'git', url: `file://${repo}` })
  const clone = join(mm.getMarketplacesCacheDir(), 'gm')

  test('a refresh that cannot reach the remote keeps the existing clone', async () => {
    renameSync(repo, `${repo}.offline`)
    try {
      await expect(
        mm.refreshMarketplace('gm', undefined, {
          disableCredentialHelper: true,
        }),
      ).rejects.toThrow('Failed to clone marketplace repository')
    } finally {
      renameSync(`${repo}.offline`, repo)
    }
    expect(existsSync(join(clone, '.git'))).toBe(true)
    expect(await pluginNames('gm')).toEqual(['a'])
    expect(cacheEntries()).toEqual(['gm'])
  })

  test('a stale directory that is not a clone is replaced by a fresh clone', async () => {
    makeRepo(repo, 'gm', ['a', 'b'])
    rmSync(clone, { recursive: true, force: true })
    mkdirSync(join(clone, '.claude-plugin'), { recursive: true })
    writeFileSync(join(clone, '.claude-plugin/marketplace.json'), '{')
    await mm.refreshMarketplace('gm', undefined, {
      disableCredentialHelper: true,
    })
    expect(existsSync(join(clone, '.git'))).toBe(true)
    expect(await pluginNames('gm')).toEqual(['a', 'b'])
    expect(cacheEntries()).toEqual(['gm'])
  })

  test('a refresh writes back only its own registry entry', async () => {
    const before = readKnown()
    let injected = false
    await mm.refreshMarketplace(
      'gm',
      () => {
        if (injected) return
        injected = true
        // Another writer registers a marketplace while the refresh runs.
        writeFileSync(
          knownFile,
          JSON.stringify({ ...readKnown(), other: before.gm }),
        )
      },
      { disableCredentialHelper: true },
    )
    const after = readKnown()
    expect(Object.keys(after).sort()).toEqual(['gm', 'other'])
    expect(after.gm.lastUpdated).not.toBe(before.gm.lastUpdated)
    expect(after.other).toEqual(before.gm)
  })

  test('a refresh does not resurrect an entry removed while it ran', async () => {
    const before = readKnown()
    let removed = false
    await mm.refreshMarketplace(
      'gm',
      () => {
        if (removed) return
        removed = true
        const { gm: _gm, ...rest } = readKnown()
        writeFileSync(knownFile, JSON.stringify(rest))
      },
      { disableCredentialHelper: true },
    )
    expect(readKnown()).toEqual({ other: before.other })
    writeFileSync(knownFile, JSON.stringify({ gm: before.gm }))
  })

  test('a failed bulk refresh keeps a GitHub clone that lives at its fetch path', async () => {
    const remote = join(root, 'remotes/acme/mkt.git')
    makeRepo(remote, 'acme-mkt', ['a'])
    await mm.addMarketplaceSource({ source: 'github', repo: 'acme/mkt' })
    const githubClone = join(mm.getMarketplacesCacheDir(), 'acme-mkt')
    expect(readKnown()['acme-mkt'].installLocation).toBe(githubClone)
    renameSync(remote, `${remote}.offline`)
    try {
      await mm.refreshAllMarketplaces()
    } finally {
      renameSync(`${remote}.offline`, remote)
    }
    expect(existsSync(join(githubClone, '.git'))).toBe(true)
    expect(await pluginNames('acme-mkt')).toEqual(['a'])
    expect(cacheEntries()).toEqual(['acme-mkt', 'gm'])
  })
}
