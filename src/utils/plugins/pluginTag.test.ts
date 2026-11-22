import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginTag, preparePluginTag } from './pluginTag.js'

let repo: string

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

const manifest = (value: object, dir = 'p') => {
  mkdirSync(join(repo, dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(repo, dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(value),
  )
}

const commit = () => {
  git('add', '-A')
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'c')
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-tag-')))
  execFileSync('git', ['init', '-q', repo])
  git('config', 'user.name', 'T')
  git('config', 'user.email', 't@example.com')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

test('plugin tag plans {name}--v{version} and creates an annotated tag at HEAD', async () => {
  manifest({ name: 'demo', version: '1.2.3' })
  commit()

  const prepared = await preparePluginTag(join(repo, 'p'))
  if (prepared.ok === false) throw new Error(prepared.error)
  expect(prepared.plan).toMatchObject({
    pluginName: 'demo',
    version: '1.2.3',
    versionFrom: 'plugin.json',
    tag: 'demo--v1.2.3',
    gitRoot: repo,
  })

  expect(
    await createPluginTag(prepared.plan, {
      push: false,
      force: false,
      message: 'release %s',
      remote: 'origin',
    }),
  ).toEqual({ ok: true, pushed: false })
  expect(git('tag', '-l', '-n1')).toBe('demo--v1.2.3    release 1.2.3')

  const again = await preparePluginTag(join(repo, 'p'))
  expect(again).toMatchObject({
    ok: false,
    error:
      'Tag "demo--v1.2.3" already exists locally. Bump the version in plugin.json, or re-run with --force to move the tag.',
  })
  expect((await preparePluginTag(join(repo, 'p'), { force: true })).ok).toBe(true)
})

test('plugin tag refuses a missing version, a non-semver version and uncommitted changes', async () => {
  manifest({ name: 'demo' })
  commit()
  expect(await preparePluginTag(join(repo, 'p'))).toMatchObject({
    ok: false,
    error: expect.stringContaining('No version to tag. Set "version" in '),
  })

  manifest({ name: 'demo', version: 'one' })
  expect(await preparePluginTag(join(repo, 'p'), { force: true })).toMatchObject({
    ok: false,
    error: expect.stringContaining('Version "one" is not valid semver.'),
  })

  manifest({ name: 'demo', version: '1.0.0' })
  expect(await preparePluginTag(join(repo, 'p'))).toMatchObject({
    ok: false,
    error: expect.stringContaining(
      '(or use --force):\n  p/.claude-plugin/plugin.json',
    ),
  })
})

test('plugin tag compares the version with the marketplace entry that lists the plugin', async () => {
  manifest({ name: 'demo', version: '1.2.3' })
  mkdirSync(join(repo, '.claude-plugin'))
  writeFileSync(
    join(repo, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'mk',
      owner: { name: 'o' },
      plugins: [{ name: 'demo', source: './p', version: '1.2.4' }],
    }),
  )
  commit()

  expect(await preparePluginTag(join(repo, 'p'))).toMatchObject({
    ok: false,
    error: expect.stringContaining(
      'Version mismatch: plugin.json says "1.2.3" but ',
    ),
  })
})

test('plugin tag keeps the local tag when the remote name is invalid', async () => {
  manifest({ name: 'demo', version: '1.2.3' })
  commit()
  const prepared = await preparePluginTag(join(repo, 'p'))
  if (prepared.ok === false) throw new Error(prepared.error)

  expect(
    await createPluginTag(prepared.plan, {
      push: true,
      force: false,
      remote: '--upload-pack=x',
    }),
  ).toEqual({
    ok: false,
    error:
      'Tag created locally but not pushed: "--upload-pack=x" is not a valid remote name.',
  })
  expect(git('tag', '-l')).toBe('demo--v1.2.3')
})
