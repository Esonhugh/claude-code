import { expect, test } from 'bun:test'
import {
  restoreSetAsideConfigs,
  restoreSetAsideSecrets,
  setAsidePluginIds,
} from './pluginSetAside.js'

const one = '.set-aside/2026-01-01T00-00-00Z.aaaaaaaaaaaa'
const two = '.set-aside/2026-02-01T00-00-00Z.bbbbbbbbbbbb'

test('restore gives set-aside options back to the plugin id, current values winning', () => {
  const configs = {
    [`${one}/demo@mk`]: {
      options: { region: 'eu', old: '1' },
      mcpServers: { s: { a: '1', b: '1' } },
    },
    [`${two}/demo@mk`]: {
      options: { region: 'us', two: '2' },
      mcpServers: { s: { b: '2' }, t: { c: '3' } },
    },
    'demo@mk': { options: { region: 'cur' }, mcpServers: { s: { a: 'cur' } } },
    [`${one}/demo@mkx`]: { options: { k: 'v' } },
    [`${one}/zzz@mk`]: { options: { k: 'v' } },
  }

  expect(restoreSetAsideConfigs(configs, 'demo@mk', false)).toEqual({
    count: 2,
    update: {
      [`${one}/demo@mk`]: undefined,
      [`${two}/demo@mk`]: undefined,
      'demo@mk': {
        options: { region: 'cur', old: '1', two: '2' },
        mcpServers: { s: { a: 'cur', b: '2' }, t: { c: '3' } },
      },
    },
  })
  expect(restoreSetAsideConfigs(configs, 'demo@mk', true)).toEqual({
    count: 2,
    update: { [`${one}/demo@mk`]: undefined, [`${two}/demo@mk`]: undefined },
  })
  expect(restoreSetAsideConfigs(configs, 'demo', false)).toEqual({
    count: 0,
    update: {},
  })
})

test('restore gives set-aside secrets back, including per-server ones', () => {
  const secrets = {
    [`${one}/demo@mk`]: { api_key: 's1', o: '1' },
    [`${two}/demo@mk`]: { api_key: 's2' },
    'demo@mk': { api_key: 'cur' },
    [`${one}/demo@mk/srv`]: { tok: 't1' },
    [`${one}/zzz@mk`]: { k: 'v' },
  }

  expect(restoreSetAsideSecrets(secrets, 'demo@mk', false)).toEqual({
    count: 3,
    secrets: {
      'demo@mk': { api_key: 'cur', o: '1' },
      'demo@mk/srv': { tok: 't1' },
      [`${one}/zzz@mk`]: { k: 'v' },
    },
  })
  expect(restoreSetAsideSecrets(secrets, 'zzz@mk', true)).toMatchObject({
    count: 1,
    secrets: { 'demo@mk': { api_key: 'cur' } },
  })
  expect(
    restoreSetAsideSecrets({ [`${one}/demo@mk`]: { k: 'v' } }, 'demo@mk', true),
  ).toEqual({ count: 1, secrets: undefined })
})

test('set-aside plugin ids are listed once, without malformed keys', () => {
  expect(
    setAsidePluginIds(
      {
        [`${one}/zzz@mk`]: {},
        [`${two}/demo@mk`]: {},
        '.set-aside/nostamp': {},
        'demo@mk': {},
      },
      { [`${one}/demo@mk/srv`]: {}, '.set-aside/a/b/demo@mk': {} },
    ),
  ).toEqual(['b', 'demo@mk', 'zzz@mk'])
})
