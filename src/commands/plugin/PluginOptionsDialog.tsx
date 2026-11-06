import figures from 'figures'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { stringWidth } from '../../ink/stringWidth.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw text input for config dialog
import { Box, Text, useInput } from '../../ink.js'
import {
  useKeybinding,
  useKeybindings,
} from '../../keybindings/useKeybinding.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { validateUserConfig } from '../../utils/plugins/mcpbHandler.js'
import {
  resolvePluginOptions,
  type PluginOptionSchema,
  type PluginOptionValues,
} from '../../utils/plugins/pluginOptionsStorage.js'

/**
 * Build the onSave payload from collected string inputs.
 *
 * Sensitive fields are never prepopulated in the text buffer (security), so
 * by the time the user reaches the last field every sensitive field they
 * stepped through contains '' in collected. To avoid silently wiping saved
 * secrets on reconfigure: if a sensitive field is '' AND initialValues has
 * a value for it, OMIT the key entirely. savePluginOptions only writes keys
 * it receives, so omitting = keep existing.
 *
 * Exported for unit testing.
 */
export function buildFinalValues(
  fields: string[],
  collected: Record<string, string>,
  configSchema: PluginOptionSchema,
  initialValues: PluginOptionValues | undefined,
): PluginOptionValues {
  const finalValues: PluginOptionValues = {}
  for (const fieldKey of fields) {
    const schema = configSchema[fieldKey]
    const value = collected[fieldKey] ?? ''

    if (
      schema?.sensitive === true &&
      value === '' &&
      initialValues?.[fieldKey] !== undefined
    ) {
      continue
    }

    if (schema?.type === 'number') {
      // Number('') returns 0, not NaN — omit blank number inputs so
      // validateUserConfig's required check actually catches them.
      if (value.trim() === '') continue
      const num = Number(value)
      finalValues[fieldKey] = Number.isNaN(num) ? value : num
    } else if (schema?.type === 'boolean') {
      finalValues[fieldKey] = isEnvTruthy(value)
    } else {
      finalValues[fieldKey] = value
    }
  }
  return finalValues
}

type Props = {
  title: string
  subtitle: string
  configSchema: PluginOptionSchema
  /** Pre-fill fields when reconfiguring. Sensitive fields are not prepopulated. */
  initialValues?: PluginOptionValues
  onSave: (config: PluginOptionValues) => void
  onCancel: () => void
}

export function PluginOptionsDialog({
  title,
  subtitle,
  configSchema,
  initialValues,
  onSave,
  onCancel,
}: Props): React.ReactNode {
  const fields = Object.keys(configSchema)

  // Prepopulate from initialValues but skip sensitive fields — we don't
  // want to echo secrets back into the text buffer.
  const initialFor = useCallback(
    (key: string): string => {
      if (configSchema[key]?.sensitive === true) return ''
      const field = configSchema[key]
      const v = resolvePluginOptions(configSchema, initialValues ?? {})[key]
      return v === undefined ? (field?.options?.[0] ?? '') : String(v)
    },
    [configSchema, initialValues],
  )

  const [currentFieldIndex, setCurrentFieldIndex] = useState(0)
  const [validationError, setValidationError] = useState('')
  const [currentInput, setCurrentInputState] = useState(() =>
    fields[0] ? initialFor(fields[0]) : '',
  )
  // Input handlers sync to a render in effects, so a key can reach one from
  // before the latest field change or typed text: confirm reads these refs.
  const fieldIndexRef = useRef(0)
  const valuesRef = useRef<Record<string, string>>({})
  const currentInputRef = useRef(currentInput)
  const setCurrentInput = useCallback(
    (next: string | ((prev: string) => string)) => {
      currentInputRef.current =
        typeof next === 'function' ? next(currentInputRef.current) : next
      setCurrentInputState(currentInputRef.current)
    },
    [],
  )

  // The picker reports its focused choice from an effect, after the render
  // that applied the key. A ↓ and Tab read in one chunk run before that
  // render, so Tab on a picker waits for it (see advancePending below).
  const focusedChoiceRef = useRef(currentInput)
  const [advancePending, setAdvancePending] = useState(false)
  // Keys that arrive while that advance is pending belong to the next field,
  // but every handler still sees the picker until it renders: hold them here.
  const advancingRef = useRef(false)
  const typedAheadRef = useRef('')
  const confirmAheadRef = useRef(false)

  const currentField = fields[currentFieldIndex]
  const fieldSchema = currentField ? configSchema[currentField] : null
  const choices =
    fieldSchema?.type === 'string' ? fieldSchema.options : undefined

  // Use Settings context so 'n' key doesn't cancel (allows typing 'n' in input).
  // isCancelActive={false} on Dialog keeps its own confirm:no out of the way.
  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  // Enter to save current field and move to next, or save all if last
  // Returns whether the dialog moved on (next field or save).
  const handleConfirm = useCallback(
    (selected = currentInputRef.current): boolean => {
      const index = fieldIndexRef.current
      const field = fields[index]
      const schema = field ? configSchema[field] : null
      if (!field || !schema) return false

      const submitted = buildFinalValues(
        [field],
        { [field]: selected },
        configSchema,
        initialValues,
      )
      const preserved =
        schema.sensitive && initialValues?.[field] !== undefined
          ? { [field]: initialValues[field] }
          : {}
      const validation = validateUserConfig(
        { ...preserved, ...submitted },
        { [field]: schema },
      )
      if (!validation.valid) {
        setValidationError(validation.errors.join('; '))
        return false
      }
      setValidationError('')
      const newValues = { ...valuesRef.current, [field]: selected }

      if (index === fields.length - 1) {
        onSave(
          buildFinalValues(fields, newValues, configSchema, initialValues),
        )
      } else {
        // Move to next field
        valuesRef.current = newValues
        fieldIndexRef.current = index + 1
        setCurrentFieldIndex(index + 1)
        const nextKey = fields[index + 1]
        setCurrentInput(nextKey ? initialFor(nextKey) : '')
      }
      return true
    },
    [
      fields,
      configSchema,
      onSave,
      initialFor,
      initialValues,
    ],
  )

  useKeybindings(
    {
      'confirm:nextField': () => {
        if (currentFieldIndex >= fields.length - 1) return
        if (choices === undefined) {
          handleConfirm()
          return
        }
        advancingRef.current = true
        setAdvancePending(true)
      },
    },
    { context: 'Confirmation' },
  )
  // Runs after the picker's own effects in the same commit, so the ref holds
  // the choice it now shows.
  useEffect(() => {
    if (!advancePending) return
    setAdvancePending(false)
    if (!handleConfirm(focusedChoiceRef.current)) {
      advancingRef.current = false
      typedAheadRef.current = ''
      confirmAheadRef.current = false
    }
  }, [advancePending, handleConfirm])

  // The next field has rendered: hand it the keys typed while advancing.
  useEffect(() => {
    if (!advancingRef.current) return
    advancingRef.current = false
    const text = typedAheadRef.current
    const confirm = confirmAheadRef.current
    typedAheadRef.current = ''
    confirmAheadRef.current = false
    if (choices === undefined && text) setCurrentInput(prev => prev + text)
    if (confirm) handleConfirm()
    // Only a field change should hand over typed-ahead keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFieldIndex])

  useKeybinding('confirm:yes', () => { handleConfirm() }, {
    context: 'Confirmation',
    isActive: choices === undefined,
  })

  // Character input handling (backspace, typing)
  useInput((char, key) => {
    if (advancingRef.current) {
      // Keys after a typed-ahead Enter would belong to a later field.
      if (confirmAheadRef.current) return
      if (key.return) confirmAheadRef.current = true
      else if (key.backspace || key.delete)
        typedAheadRef.current = typedAheadRef.current.slice(0, -1)
      else if (char && !key.ctrl && !key.meta && !key.tab && !key.return)
        typedAheadRef.current += char
      return
    }
    if (choices !== undefined) return
    // Backspace
    if (key.backspace || key.delete) {
      setCurrentInput(prev => prev.slice(0, -1))
      return
    }

    // Regular character input
    if (char && !key.ctrl && !key.meta && !key.tab && !key.return) {
      setCurrentInput(prev => prev + char)
    }
  })

  if (!fieldSchema || !currentField) {
    return null
  }

  const isSensitive = fieldSchema.sensitive === true
  const isRequired = fieldSchema.required === true
  const displayValue = isSensitive
    ? '*'.repeat(stringWidth(currentInput))
    : currentInput

  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      onCancel={onCancel}
      isCancelActive={false}
    >
      <Box flexDirection="column">
        <Text bold={true}>
          {fieldSchema.title || currentField}
          {isRequired && <Text color="error"> *</Text>}
        </Text>
        {fieldSchema.description && (
          <Text dimColor={true}>{fieldSchema.description}</Text>
        )}

        <Box marginTop={1}>
          {choices !== undefined ? (
            <Select
              key={currentField}
              options={choices.map(value => ({ label: value, value }))}
              defaultValue={currentInput}
              defaultFocusValue={currentInput}
              onFocus={value => {
                focusedChoiceRef.current = value
                setCurrentInput(value)
              }}
              onChange={value => {
                // Enter while a Tab is still applying confirms the next field.
                if (advancingRef.current) confirmAheadRef.current = true
                else handleConfirm(value)
              }}
              onCancel={onCancel}
            />
          ) : (
            <>
              <Text>{figures.pointerSmall} </Text>
              <Text>{displayValue}</Text>
              <Text>█</Text>
            </>
          )}
        </Box>
        {validationError && <Text color="error">{validationError}</Text>}
      </Box>

      <Box flexDirection="column">
        <Text dimColor={true}>
          Field {currentFieldIndex + 1} of {fields.length}
        </Text>
        {currentFieldIndex < fields.length - 1 && (
          <Text dimColor={true}>
            Tab: Next field · Enter: Save and continue
          </Text>
        )}
        {currentFieldIndex === fields.length - 1 && (
          <Text dimColor={true}>Enter: Save configuration</Text>
        )}
      </Box>
    </Dialog>
  )
}
