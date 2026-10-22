import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { checkPathSafetyForAutoEdit } from './filesystem.js'

const root = join('/', 'protected-files-test-project')

describe('checkPathSafetyForAutoEdit protected files', () => {
  test.each([
    '.zshenv',
    '.zlogin',
    '.zlogout',
    '.bash_login',
    '.bash_aliases',
    '.bash_logout',
    '.envrc',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pnp.cjs',
    '.pnp.loader.mjs',
    '.pnpmfile.cjs',
    'bunfig.toml',
    '.bunfig.toml',
    '.bazelrc',
    '.bazelversion',
    '.bazeliskrc',
    '.pre-commit-config.yaml',
    'lefthook.yml',
    '.lefthook.yml',
    'lefthook.yaml',
    '.lefthook.yaml',
    'gradle/wrapper/gradle-wrapper.properties',
    'maven-wrapper.properties',
    '.devcontainer.json',
    'pyrightconfig.json',
    'BUNFIG.TOML',
  ])('%s requires approval', file => {
    expect(checkPathSafetyForAutoEdit(join(root, file)).safe).toBe(false)
  })

  test.each([
    '.husky/pre-commit',
    '.cargo/config.toml',
    '.devcontainer/devcontainer.json',
    '.yarn/plugins/plugin.cjs',
    '.mvn/wrapper/maven-wrapper.properties',
    '.Husky/pre-push',
  ])('%s inside a protected directory requires approval', file => {
    expect(checkPathSafetyForAutoEdit(join(root, file)).safe).toBe(false)
  })

  test('.config/git files require approval', () => {
    expect(
      checkPathSafetyForAutoEdit(join(homedir(), '.config', 'git', 'config'))
        .safe,
    ).toBe(false)
    expect(
      checkPathSafetyForAutoEdit(join(root, '.config', 'Git', 'ignore')).safe,
    ).toBe(false)
  })

  test.each([
    'src/app.ts',
    'config/git/notes.md',
    '.config/gitx/config',
    '.config/git-tools.json',
    'husky/readme.md',
    'docs/bunfig.toml.md',
  ])('%s stays auto-editable', file => {
    expect(checkPathSafetyForAutoEdit(join(root, file)).safe).toBe(true)
  })
})
