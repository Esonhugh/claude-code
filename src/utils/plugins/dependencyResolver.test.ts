import { expect, test } from 'bun:test'
import type { LoadedPlugin } from '../../types/plugin.js'
import {
  findOrphanedAutoDependencies,
  findTransitiveReverseDependents,
  formatDependencyCountSuffix,
  formatOrphanedDependenciesNote,
  formatUnresolvedDependencySuffix,
  resolveEnableClosure,
} from './dependencyResolver.js'

const plugin = (
  name: string,
  dependencies?: string[],
  enabled = true,
): LoadedPlugin => ({
  name,
  manifest: { name, dependencies },
  path: `/plugins/${name}`,
  source: `${name}@mk`,
  repository: `${name}@mk`,
  enabled,
})

test('the install suffix names the dependencies that were installed', () => {
  expect(formatDependencyCountSuffix([])).toBe('')
  expect(formatDependencyCountSuffix(['base@mk'])).toBe(
    ' (+ 1 dependency: base)',
  )
  expect(formatDependencyCountSuffix(['child@mk', 'base@mk'])).toBe(
    ' (+ 2 dependencies: child, base)',
  )
  expect(
    formatDependencyCountSuffix(['a@m', 'b@m', 'c@m', 'd@m', 'e@m', 'f@m']),
  ).toBe(' (+ 6 dependencies: a, b, c, d, e, \u2026)')
})

test('the unresolved suffix lists what is still missing and asks for a missing marketplace', () => {
  expect(formatUnresolvedDependencySuffix([], [])).toBe('')
  expect(formatUnresolvedDependencySuffix(['nope@mk'], [])).toBe(
    ' \u2014 1 dependency still unresolved: nope@mk.',
  )
  expect(formatUnresolvedDependencySuffix(['a@mk', 'x@far'], ['x@far'])).toBe(
    ' \u2014 2 dependencies still unresolved: a@mk, x@far. Is the "far" marketplace added?',
  )
  expect(formatUnresolvedDependencySuffix(['x'], ['x'])).toBe(
    " \u2014 1 dependency still unresolved: x. Add the dependency's marketplace, then re-run install.",
  )
  expect(
    formatUnresolvedDependencySuffix(['a@m', 'b@m', 'c@m', 'd@m', 'e@m', 'f@m', 'g@m'], []),
  ).toBe(' \u2014 7 dependencies still unresolved: a@m, b@m, c@m, d@m, e@m and 2 more.')
})

test('transitive reverse dependents list every enabled plugin that needs the target', () => {
  const plugins = [
    plugin('base'),
    plugin('child', ['base']),
    plugin('chain', ['child']),
    plugin('off', ['base'], false),
    plugin('lone'),
  ]
  expect(findTransitiveReverseDependents('base@mk', plugins)).toEqual([
    'chain@mk',
    'child@mk',
  ])
  expect(findTransitiveReverseDependents('lone@mk', plugins)).toEqual([])
})

test('enabling a plugin collects its installed dependencies and reports missing ones', () => {
  const plugins = [
    plugin('base', undefined, false),
    plugin('child', ['base'], false),
    plugin('chain', ['child', 'nope'], false),
    plugin('cyca', ['cycb'], false),
    plugin('cycb', ['cyca'], false),
  ]
  expect(resolveEnableClosure('child@mk', plugins)).toEqual({
    closure: ['base@mk'],
    missing: [],
  })
  expect(resolveEnableClosure('chain@mk', plugins)).toEqual({
    closure: ['child@mk', 'base@mk'],
    missing: ['nope@mk'],
  })
  expect(resolveEnableClosure('cyca@mk', plugins)).toEqual({
    closure: ['cycb@mk'],
    missing: [],
  })
})

test('auto-installed dependencies are orphaned once no manual install reaches them', () => {
  const record = (auto?: boolean, scope: 'user' | 'project' = 'user') => [
    {
      scope,
      installPath: '/p',
      ...(scope === 'project' && { projectPath: '/proj' }),
      ...(auto && { auto }),
    },
  ]
  const loaded = [
    plugin('base'),
    plugin('child', ['base'], false),
    plugin('lone'),
    plugin('cyca', ['cycb']),
    plugin('cycb', ['cyca']),
  ]
  expect(
    findOrphanedAutoDependencies(
      {
        'base@mk': record(true),
        'child@mk': record(),
        'lone@mk': record(true),
        'cyca@mk': record(),
        'cycb@mk': record(true),
        'other@mk': record(true, 'project'),
      },
      loaded,
      'user',
    ),
  ).toEqual({ orphans: ['lone@mk'], unloadable: [], autoCount: 3 })
  expect(
    findOrphanedAutoDependencies({ 'child@mk': record() }, loaded, 'user'),
  ).toEqual({ orphans: [], unloadable: [], autoCount: 0 })
  expect(
    findOrphanedAutoDependencies(
      { 'gone@mk': record(), 'base@mk': record(true) },
      loaded,
      'user',
    ),
  ).toEqual({ orphans: [], unloadable: ['gone@mk'], autoCount: 1 })
  expect(
    findOrphanedAutoDependencies(
      { 'base@mk': record(true, 'project') },
      loaded,
      'project',
      '/elsewhere',
    ),
  ).toEqual({ orphans: [], unloadable: [], autoCount: 0 })
})

test('the orphan note points at plugin prune for the scope', () => {
  expect(formatOrphanedDependenciesNote([], 'user')).toBe('')
  expect(formatOrphanedDependenciesNote(['base@mk', 'lone@mk'], 'user')).toBe(
    '\n2 auto-installed dependencies no longer needed: base, lone. Run `claude plugin prune` to remove.',
  )
  expect(formatOrphanedDependenciesNote(['base@mk'], 'project')).toBe(
    '\n1 auto-installed dependency no longer needed: base. Run `claude plugin prune --scope project` to remove.',
  )
})
