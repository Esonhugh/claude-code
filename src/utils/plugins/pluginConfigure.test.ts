import { expect, test } from 'bun:test'
import {
  describePluginOptions,
  parseOptionValues,
  PluginOptionRefusedError,
  pluginDisplayName,
  preparePluginOptionValues,
  printable,
  redactOptionValues,
} from './pluginConfigure.js'
import type { PluginOptionSchema } from './pluginOptionsStorage.js'

const schema: PluginOptionSchema = {
  api_key: {
    type: 'string',
    title: 'API key',
    description: 'key',
    required: true,
    sensitive: true,
  },
  region: { type: 'string', title: 'Region', description: 'r' },
  debug: { type: 'boolean', title: 'debug', description: 'b' },
  retries: { type: 'number', title: 'Retries', description: 'n', min: 0, max: 5 },
  mode: {
    type: 'string',
    title: 'Mode',
    description: 'm',
    options: ['fast', 'slow'],
    default: 'fast',
  },
}

const refusal = (values: Record<string, string>, saved = {}) => {
  try {
    preparePluginOptionValues(schema, values, saved)
  } catch (error) {
    if (error instanceof PluginOptionRefusedError) {
      return [error.option, error.message]
    }
    throw error
  }
  return undefined
}

test('plugin configure takes only a JSON object of strings from stdin', () => {
  expect(parseOptionValues({ region: 'eu' })).toEqual({ region: 'eu' })
  expect(parseOptionValues({ region: 1 })).toBeUndefined()
  expect(parseOptionValues([1])).toBeUndefined()
  expect(parseOptionValues(null)).toBeUndefined()
})

test('plugin configure turns the strings into typed values and leaves blanks alone', () => {
  expect(
    preparePluginOptionValues(
      schema,
      { api_key: ' k ', debug: 'yes', retries: ' 3 ', mode: 'slow', region: '' },
      {},
    ),
  ).toEqual({ api_key: 'k', debug: true, retries: 3, mode: 'slow' })
  // A blank keeps a saved secret and a number, and clears a saved optional string.
  expect(
    preparePluginOptionValues(
      schema,
      { api_key: '', retries: '', region: '', mode: '' },
      { api_key: 'old', retries: 3, region: 'eu', mode: 'slow' },
    ),
  ).toEqual({ region: '', mode: '' })
})

test('plugin configure refuses values the declared option does not take', () => {
  expect(refusal({ zzz: '1', yyy: '2' })).toEqual([
    undefined,
    'This plugin has no options "zzz", "yyy". Known options: api_key, region, debug, retries, mode.',
  ])
  expect(refusal({ api_key: '  ' })).toEqual([
    'api_key',
    'API key is required but not provided',
  ])
  expect(refusal({ debug: 'maybe' })).toEqual([
    'debug',
    'debug must be true or false (or 1/0, yes/no, on/off).',
  ])
  expect(refusal({ retries: '9' })).toEqual([
    'retries',
    'Retries: It takes a number between 0 and 5.',
  ])
  expect(refusal({ mode: 'medium' })).toEqual([
    'mode',
    'Mode must be one of: fast, slow',
  ])
  expect(refusal({ region: 'a\nb' })).toEqual([
    'region',
    'Region must be a single line.',
  ])
  expect(refusal({ region: 'x'.repeat(70000) })).toEqual([
    'region',
    'Region is too long (over 64 KB).',
  ])
})

test('plugin configure reports what is set without showing secrets', () => {
  expect(
    describePluginOptions(
      schema,
      { api_key: 'sekret', region: 'eu', debug: true },
      { region: 'eu', debug: true },
    ),
  ).toEqual({
    inputs: { api_key: '', region: 'eu', debug: 'true', retries: '', mode: 'fast' },
    choices: { debug: ['true', 'false'], mode: ['fast', 'slow'] },
    configured: ['api_key', 'region', 'debug'],
    unconfigured: ['retries', 'mode'],
  })
  expect(
    redactOptionValues(schema, { api_key: ' sekret ' }, 'bad sekret, sekret'),
  ).toBe('bad …, …')
})

test('plugin configure keeps plugin-supplied control sequences off the terminal', () => {
  expect(
    pluginDisplayName({ name: 'demo', displayName: 'Dis\u001b[31mplay\u0007' }),
  ).toBe('Display')
  expect(pluginDisplayName({ name: 'demo', displayName: '\u001b[2J' })).toBe(
    'demo',
  )
  expect(printable('Fl\u001b[2Jag\b')).toBe('Flag ')
})
