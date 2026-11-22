import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { valid } from 'semver'
import { getCwd } from '../cwd.js'
import { errorMessage, isENOENT } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { isSafeRefName } from '../git/gitFilesystem.js'
import { findGitRoot, gitExe } from '../git.js'
import { stripBOM } from '../jsonRead.js'
import { jsonParse } from '../slowOperations.js'
import { PluginMarketplaceSchema } from './schemas.js'
import {
  validatePluginContents,
  validatePluginManifest,
} from './validatePlugin.js'

export type PluginTagPlan = {
  pluginName: string
  version: string
  versionFrom: 'plugin.json' | 'marketplace entry'
  tag: string
  pluginRoot: string
  gitRoot: string
  marketplace?: { path: string; entryIndex: number; entryVersion?: string }
}

type Prepared =
  | { ok: true; warnings: string[]; plan: PluginTagPlan }
  | { ok: false; warnings: string[]; error: string }

type Manifest =
  | { ok: true; pluginRoot: string; manifestPath: string; manifest: Record<string, unknown> }
  | { ok: false; error: string }

async function readManifest(path: string): Promise<Manifest> {
  const target = resolve(path)
  let isFile: boolean
  try {
    isFile = (await stat(target)).isFile()
  } catch (error) {
    return {
      ok: false,
      error: isENOENT(error)
        ? `Path not found: ${target}`
        : `Cannot stat ${target}: ${errorMessage(error)}`,
    }
  }
  const candidates = isFile
    ? [[dirname(dirname(target)), target]]
    : [
        [target, join(target, '.claude-plugin', 'plugin.json')],
        [dirname(target), join(target, 'plugin.json')],
      ]
  for (const [pluginRoot, manifestPath] of candidates) {
    let text: string
    try {
      text = await readFile(manifestPath!, 'utf8')
    } catch (error) {
      if (isENOENT(error)) continue
      return { ok: false, error: `Cannot read ${manifestPath}: ${errorMessage(error)}` }
    }
    let manifest: unknown
    try {
      manifest = jsonParse(stripBOM(text))
    } catch (error) {
      return { ok: false, error: `Invalid JSON in ${manifestPath}: ${errorMessage(error)}` }
    }
    return {
      ok: true,
      pluginRoot: pluginRoot!,
      manifestPath: manifestPath!,
      manifest:
        typeof manifest === 'object' && manifest !== null
          ? (manifest as Record<string, unknown>)
          : {},
    }
  }
  return {
    ok: false,
    error: `No plugin manifest found. Expected ${join(target, '.claude-plugin', 'plugin.json')}.`,
  }
}

/** The marketplace.json, from the plugin up to the git root, that lists the plugin. */
async function findMarketplaceEntry(pluginRoot: string, name: string) {
  const gitRoot = findGitRoot(pluginRoot)
  for (let dir = pluginRoot; ; ) {
    const path = join(dir, '.claude-plugin', 'marketplace.json')
    const marketplace = await readFile(path, 'utf8')
      .then(text => PluginMarketplaceSchema().safeParse(jsonParse(stripBOM(text))))
      .catch(() => undefined)
    if (marketplace?.success) {
      for (const [entryIndex, entry] of marketplace.data.plugins.entries()) {
        const listed =
          typeof entry.source === 'string'
            ? resolve(dir, entry.source) === pluginRoot
            : entry.name === name
        if (listed) return { path, entryIndex, entry }
      }
    }
    const parent = dirname(dir)
    if (dir === gitRoot || parent === dir) return undefined
    dir = parent
  }
}

const git = (gitRoot: string, args: string[]) =>
  execFileNoThrow(gitExe(), ['-C', gitRoot, ...args])

export async function preparePluginTag(
  path: string,
  options: { force?: boolean } = {},
): Promise<Prepared> {
  const warnings: string[] = []
  const fail = (error: string): Prepared => ({ ok: false, error, warnings })

  const read = await readManifest(path)
  if (read.ok === false) return fail(read.error)
  const { pluginRoot, manifestPath, manifest } = read
  const listing =
    typeof manifest.name === 'string' && manifest.name.length > 0
      ? await findMarketplaceEntry(pluginRoot, manifest.name)
      : undefined

  const manifestResult = await validatePluginManifest(manifestPath)
  const results = [manifestResult]
  if (manifestResult.success) {
    results.push(...(await validatePluginContents(pluginRoot)))
  }
  for (const result of results) {
    for (const warning of result.warnings) {
      warnings.push(`${relative(getCwd(), result.filePath)}: ${warning.message}`)
    }
  }
  const invalid = results.find(result => !result.success)
  if (invalid) {
    const errors = invalid.errors
      .map(error => `  ${error.path}: ${error.message}`)
      .join('\n')
    return fail(`Plugin validation failed for ${invalid.filePath}:\n${errors}`)
  }

  const pluginName = manifest.name
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    return fail(`plugin.json at ${manifestPath} has no "name" field`)
  }
  const manifestVersion =
    typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : undefined
  const entryVersion = listing?.entry.version
  const entryPlace = listing
    ? `${relative(getCwd(), listing.path)} plugins[${listing.entryIndex}]`
    : undefined
  const version = manifestVersion ?? entryVersion
  if (version === undefined) {
    return fail(
      `No version to tag. Set "version" in ${relative(getCwd(), manifestPath)}` +
        (entryPlace ? ` or in the marketplace entry at ${entryPlace}.` : '.') +
        ' Tags are only used for dependency version constraints and for finding an older version that fits this Claude Code, which require an explicit semver — the git-SHA fallback does not need a tag.',
    )
  }
  if (entryVersion && manifestVersion !== undefined && entryVersion !== manifestVersion) {
    return fail(
      `Version mismatch: plugin.json says "${manifestVersion}" but ${entryPlace}.version says "${entryVersion}". plugin.json wins at install time, so update the marketplace entry to "${manifestVersion}" (or remove it) before tagging.`,
    )
  }
  if (valid(version) === null) {
    return fail(
      `Version "${version}" is not valid semver. Dependency resolution (resolveVersionRange) ignores tags whose suffix doesn't parse as semver, so this tag would never be selected.`,
    )
  }
  const versionFrom = manifestVersion !== undefined ? 'plugin.json' : 'marketplace entry'

  const tag = `${pluginName}--v${version}`
  // The tag is printed inside git commands to copy, so only plain ref characters.
  if (!isSafeRefName(tag)) {
    return fail(
      `Computed tag name "${tag}" is not a valid git ref. Check the plugin name for characters git rejects (spaces, ~, ^, :, ?, *, [, \\, or sequences like .., @{, //).`,
    )
  }
  const gitRoot = findGitRoot(pluginRoot)
  if (gitRoot === null) {
    return fail(
      `${pluginRoot} is not inside a git repository. Dependency tags are resolved via git ls-remote, so the plugin must live in a git repo.`,
    )
  }

  if (!options.force) {
    const paths = listing ? [pluginRoot, listing.path] : [pluginRoot]
    const status = await git(gitRoot, [
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--ignore-submodules=dirty',
      '--',
      ...paths.map(p => relative(gitRoot, p) || '.'),
    ])
    const dirty =
      status.code === 0
        ? status.stdout
            .split('\n')
            .map(line => line.slice(3).trim())
            .filter(Boolean)
        : []
    if (dirty.length > 0) {
      const more = dirty.length > 5 ? `\n  …and ${dirty.length - 5} more` : ''
      return fail(
        `Uncommitted changes affecting this release — commit them first so the tag points at the version you intend to release (or use --force):\n  ${dirty.slice(0, 5).join('\n  ')}${more}`,
      )
    }
    const existing = await git(gitRoot, ['tag', '-l', '--', tag])
    if (existing.code === 0 && existing.stdout.trim() === tag) {
      return fail(
        `Tag "${tag}" already exists locally. Bump the version in ${versionFrom}, or re-run with --force to move the tag.`,
      )
    }
  }

  return {
    ok: true,
    warnings,
    plan: {
      pluginName,
      version,
      versionFrom,
      tag,
      pluginRoot,
      gitRoot,
      marketplace: listing && {
        path: listing.path,
        entryIndex: listing.entryIndex,
        entryVersion,
      },
    },
  }
}

export function pluginTagMessage(plan: PluginTagPlan, message?: string): string {
  return message === undefined
    ? `${plan.pluginName} ${plan.version}`
    : message.replaceAll('%s', plan.version)
}

export async function createPluginTag(
  plan: PluginTagPlan,
  options: { push: boolean; force: boolean; message?: string; remote: string },
): Promise<{ ok: true; pushed: boolean } | { ok: false; error: string }> {
  const tagged = await git(plan.gitRoot, [
    'tag',
    ...(options.force ? ['-f'] : []),
    '-a',
    '-m',
    pluginTagMessage(plan, options.message),
    '--',
    plan.tag,
    'HEAD',
  ])
  if (tagged.code !== 0) {
    return {
      ok: false,
      error: `git tag failed (exit ${tagged.code}): ${tagged.stderr.trim() || tagged.stdout.trim()}`,
    }
  }
  if (!options.push) return { ok: true, pushed: false }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.remote)) {
    return {
      ok: false,
      error: `Tag created locally but not pushed: "${options.remote}" is not a valid remote name.`,
    }
  }
  const pushed = await git(plan.gitRoot, [
    'push',
    ...(options.force ? ['--force'] : []),
    options.remote,
    `refs/tags/${plan.tag}`,
  ])
  if (pushed.code !== 0) {
    return {
      ok: false,
      error: `Tag created locally but push failed (exit ${pushed.code}): ${pushed.stderr.trim() || pushed.stdout.trim()}`,
    }
  }
  return { ok: true, pushed: true }
}
