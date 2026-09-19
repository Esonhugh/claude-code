import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./main.tsx', import.meta.url)).text()
const cliSelection = source.slice(
  source.indexOf('      const userSpecifiedModel ='),
  source.indexOf('      const userSpecifiedFallbackModel ='),
)
const initialization = source.slice(
  source.indexOf('      // Set the CLI choice before considering an agent-definition fallback.'),
  source.indexOf('      // Compute resolved model for hooks'),
)

function initializeModel(cli?: string, env?: string, saved?: string, agent?: string) {
  let override: string | null | undefined
  const result = new Function(
    'options', 'mainThreadAgentDefinition', 'setMainLoopModelOverride',
    'getUserSpecifiedModelSetting', 'getDefaultMainLoopModel',
    `${cliSelection}\n${initialization}\nreturn effectiveModel`,
  )(
    { model: cli }, { model: agent },
    (model: string | null | undefined) => { override = model },
    () => override !== undefined ? override : env || saved || undefined,
    () => 'provider-default',
  )
  return { result, override }
}

describe('startup model precedence', () => {
  test('CLI wins over env, saved settings and main agent definition', () => {
    expect(initializeModel('cli', 'env', 'saved', 'agent')).toEqual({
      result: 'cli', override: 'cli',
    })
  })
  test('env and saved settings each win over the main agent definition', () => {
    expect(initializeModel(undefined, 'env', 'saved', 'agent').result).toBe('env')
    expect(initializeModel(undefined, undefined, 'saved', 'agent').result).toBe('saved')
  })
  test('CLI default blocks lower sources without pinning provider ID', () => {
    expect(initializeModel('default', 'env', 'saved', 'agent')).toEqual({
      result: 'provider-default', override: null,
    })
  })
  test('explicit main agent model is used only as a fallback', () => {
    expect(initializeModel(undefined, undefined, undefined, 'agent')).toEqual({
      result: 'agent', override: 'agent',
    })
    expect(initializeModel(undefined, undefined, undefined, 'inherit')).toEqual({
      result: undefined, override: undefined,
    })
  })

  test('startup migrations do not rewrite saved model choices', () => {
    const migrations = source.slice(source.indexOf('function runMigrations(): void {'))
      .split('\n/**')[0]!
      .replace('function runMigrations(): void', 'function runMigrations()')
    const rewrite = () => { throw new Error('rewrote explicit model setting') }
    const migrationNames = [
      'migrateAutoUpdatesToSettings', 'migrateBypassPermissionsAcceptedToSettings',
      'migrateEnableAllProjectMcpServersToSettings', 'resetProToOpusDefault',
      'migrateSonnet1mToSonnet45', 'migrateLegacyOpusToCurrent',
      'migrateSonnet45ToSonnet46', 'migrateOpusToOpus1m',
      'migrateReplBridgeEnabledToRemoteControlAtStartup', 'resetAutoModeOptInForDefaultOffer',
      'migrateFennecToOpus',
    ]
    const rewriteNames = new Set([
      'migrateSonnet1mToSonnet45', 'migrateLegacyOpusToCurrent',
      'migrateSonnet45ToSonnet46', 'migrateOpusToOpus1m',
    ])
    const execute = new Function(
      'CURRENT_MIGRATION_VERSION', 'getGlobalConfig', 'saveGlobalConfig', 'feature', 'isAnt',
      ...migrationNames, `${migrations}\nrunMigrations()`,
    )
    expect(() => execute(
      12, () => ({ migrationVersion: 0 }), () => {}, () => false, () => false,
      ...migrationNames.map(name => rewriteNames.has(name) ? rewrite : () => {}),
    )).not.toThrow()
  })
})
