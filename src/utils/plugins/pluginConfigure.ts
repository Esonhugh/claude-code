import stripAnsi from 'strip-ansi'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { plural } from '../stringUtils.js'
import { validateUserConfig } from './mcpbHandler.js'
import type {
  PluginOptionSchema,
  PluginOptionValues,
} from './pluginOptionsStorage.js'

export const MAX_VALUES_STDIN_BYTES = 256 * 1024
const MAX_VALUE_BYTES = 64 * 1024

export class PluginOptionRefusedError extends Error {
  constructor(
    message: string,
    readonly option?: string,
  ) {
    super(message)
  }
}

/** Plugin-controlled text on its way to the terminal. */
export function printable(text: string): string {
  return stripAnsi(text).replace(/\p{Cc}/gu, ' ')
}

/** The name to show for a plugin: its displayName when that has anything printable. */
export function pluginDisplayName(manifest: {
  name: string
  displayName?: string
}): string {
  return printable(manifest.displayName ?? '').trim() || printable(manifest.name)
}

const own = <T>(object: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(object, key) ? object[key] : undefined

const label = (key: string, field: PluginOptionSchema[string] | undefined) =>
  printable(field?.title || key)

const toBoolean = (value: string): boolean | undefined =>
  isEnvTruthy(value) ? true : isEnvDefinedFalsy(value) ? false : undefined

export function parseOptionValues(
  json: unknown,
): Record<string, string> | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return undefined
  }
  const values: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(json)) {
    if (typeof value !== 'string') return undefined
    values[key] = value
  }
  return values
}

/**
 * Check the strings from stdin against the declared options and return the
 * typed values to save. A blank keeps a saved secret and never sets a number.
 */
export function preparePluginOptionValues(
  schema: PluginOptionSchema,
  values: Record<string, string>,
  saved: PluginOptionValues,
): PluginOptionValues {
  const unknown = Object.keys(values).filter(key => !Object.hasOwn(schema, key))
  if (unknown.length > 0) {
    const known = Object.keys(schema).map(printable)
    throw new PluginOptionRefusedError(
      `This plugin has no ${plural(unknown.length, 'option')} ${unknown.map(key => `"${printable(key)}"`).join(', ')}.` +
        (known.length > 0 ? ` Known options: ${known.join(', ')}.` : ''),
    )
  }
  const final: PluginOptionValues = {}
  for (const [key, raw] of Object.entries(values)) {
    const field = schema[key]
    const name = label(key, field)
    if (Buffer.byteLength(raw, 'utf8') > MAX_VALUE_BYTES) {
      throw new PluginOptionRefusedError(`${name} is too long (over 64 KB).`, key)
    }
    if (/[\r\n]/.test(raw)) {
      throw new PluginOptionRefusedError(`${name} must be a single line.`, key)
    }
    const value = raw.trim()
    const old = own(saved, key)
    const keepsSecret =
      field?.sensitive === true && old !== undefined && old !== ''
    if (value === '') {
      if (field?.required === true && !keepsSecret) {
        throw new PluginOptionRefusedError(
          `${name} is required but not provided`,
          key,
        )
      }
      if (
        (field?.sensitive === true && old !== undefined) ||
        field?.type === 'number' ||
        (field?.required !== true && old === undefined)
      ) {
        continue
      }
    }
    if (field?.type === 'boolean') {
      const parsed = toBoolean(value)
      if (parsed !== undefined) {
        final[key] = parsed
      } else if (value !== '') {
        throw new PluginOptionRefusedError(
          `${name} must be true or false (or 1/0, yes/no, on/off).`,
          key,
        )
      }
    } else if (field?.type === 'number') {
      const parsed = Number(value)
      if (
        !Number.isFinite(parsed) ||
        (field.min !== undefined && parsed < field.min) ||
        (field.max !== undefined && parsed > field.max)
      ) {
        const range =
          field.min !== undefined || field.max !== undefined
            ? ` between ${field.min ?? '-∞'} and ${field.max ?? '∞'}`
            : ''
        throw new PluginOptionRefusedError(
          `${name}: It takes a number${range}.`,
          key,
        )
      }
      final[key] = parsed
    } else {
      final[key] = value
    }
  }
  for (const key of Object.keys(final)) {
    const check = validateUserConfig(
      { [key]: final[key]! },
      { [key]: schema[key]! },
    )
    if (!check.valid) {
      throw new PluginOptionRefusedError(printable(check.errors.join('; ')), key)
    }
  }
  return final
}

/** Options with no saved value, or with a saved value the option no longer takes. */
export function unsetPluginOptions(
  schema: PluginOptionSchema,
  saved: PluginOptionValues,
): string[] {
  return Object.entries(schema)
    .filter(([key, field]) => {
      const value = own(saved, key)
      return (
        value === undefined ||
        value === '' ||
        (field.sensitive !== true &&
          !validateUserConfig({ [key]: value }, { [key]: field }).valid)
      )
    })
    .map(([key]) => key)
}

/** What `plugin configure <plugin> --json` reports besides the schema. */
export function describePluginOptions(
  schema: PluginOptionSchema,
  saved: PluginOptionValues,
  settingsOptions: PluginOptionValues,
): {
  inputs: Record<string, string>
  choices: Record<string, readonly string[]>
  configured: string[]
  unconfigured: string[]
} {
  const inputs: Record<string, string> = {}
  const choices: Record<string, readonly string[]> = {}
  const configured: string[] = []
  for (const [key, field] of Object.entries(schema)) {
    const value = own(saved, key)
    const isSet = value !== undefined && value !== ''
    if (isSet) configured.push(key)
    if (field.type === 'boolean') {
      const current = isSet ? value : field.default
      inputs[key] = String(current === true || current === 'true')
      choices[key] = ['true', 'false']
      continue
    }
    // Secrets never reach the output: only what settings.json already holds.
    const fromSettings = own(settingsOptions, key)
    const shown =
      isSet &&
      field.sensitive !== true &&
      fromSettings !== undefined &&
      fromSettings !== ''
        ? fromSettings
        : undefined
    if (field.type === 'string' && field.multiple !== true && field.options) {
      choices[key] = field.options
      inputs[key] =
        [shown, field.default].find(
          (candidate): candidate is string =>
            typeof candidate === 'string' && field.options!.includes(candidate),
        ) ??
        field.options[0] ??
        ''
    } else {
      inputs[key] = shown === undefined ? '' : String(shown)
    }
  }
  return {
    inputs,
    choices,
    configured,
    unconfigured: unsetPluginOptions(schema, saved),
  }
}

/** Replace the secrets that came in on stdin wherever they show up in a message. */
export function redactOptionValues(
  schema: PluginOptionSchema,
  values: Record<string, string>,
  text: string,
): string {
  return Object.entries(values)
    .filter(([key]) => own(schema, key)?.sensitive)
    .flatMap(([, value]) => [value, value.trim()])
    .filter(value => value !== '')
    .sort((a, b) => b.length - a.length)
    .reduce((message, secret) => message.split(secret).join('…'), text)
}
