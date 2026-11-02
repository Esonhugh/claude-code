import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import type { Color } from '../ink/styles.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import {
  type CustomTheme,
  getCustomThemes,
  getCustomThemesDir,
  saveCustomTheme,
  setCustomThemePreview,
  type ThemeOverrides,
  uniqueCustomThemeSlug,
} from '../utils/customThemes.js'
import { plural } from '../utils/stringUtils.js'
import {
  getBuiltinTheme,
  isThemeColorValue,
  type Theme,
  type ThemeName,
} from '../utils/theme.js'
import { Byline } from './design-system/Byline.js'
import { FuzzyPicker } from './design-system/FuzzyPicker.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import TextInput from './TextInput.js'

type Props = {
  /** The theme to edit; omitted to create a new one. */
  initial?: CustomTheme
  defaultBase: ThemeName
  /** Called once a new theme is named and saved, to switch to it. */
  onPick: (theme: CustomTheme) => void
  onDone: (theme: CustomTheme) => void
  onCancel: () => void
}

type Token = keyof Theme

export function CustomThemeEditor({
  initial,
  defaultBase,
  onPick,
  onDone,
  onCancel,
}: Props): React.ReactNode {
  const [step, setStep] = useState<'name' | 'colors'>(
    initial ? 'colors' : 'name',
  )
  const [name, setName] = useState(initial?.name ?? '')
  const [nameCursor, setNameCursor] = useState(name.length)
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const base = initial?.base ?? defaultBase
  const preset = getBuiltinTheme(base)
  const [overrides, setOverrides] = useState<ThemeOverrides>(
    initial?.overrides ?? {},
  )
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Token | null>(null)
  const [value, setValue] = useState('')
  const [valueCursor, setValueCursor] = useState(0)

  const draftSlug = slug || uniqueCustomThemeSlug(name, getCustomThemes())
  const tokens = (Object.keys(preset) as Token[]).sort()
  const filtered = query
    ? tokens.filter(token => token.toLowerCase().includes(query.toLowerCase()))
    : tokens
  const currentValue = (token: Token) => overrides[token] ?? preset[token]
  const customizedCount = Object.keys(overrides).length

  useEffect(() => () => setCustomThemePreview(slug, null), [slug])

  const save = (next: ThemeOverrides) => {
    setOverrides(next)
    setCustomThemePreview(slug, next)
    saveCustomTheme({ slug, name: name.trim(), base, overrides: next })
  }

  const cancelEditing = () => {
    setCustomThemePreview(slug, overrides)
    setEditing(null)
  }

  useKeybinding(
    'confirm:no',
    () => {
      if (editing !== null) cancelEditing()
      else onCancel()
    },
    { context: 'Settings', isActive: step === 'name' || editing !== null },
  )

  if (step === 'name') {
    const trimmed = name.trim()
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold color="permission">
            New custom theme
          </Text>
          <Box flexDirection="column">
            <Box>
              <Text>Name: </Text>
              <TextInput
                value={name}
                onChange={setName}
                onSubmit={() => {
                  if (!trimmed) return
                  const theme = {
                    slug: draftSlug,
                    name: trimmed,
                    base,
                    overrides,
                  }
                  setSlug(draftSlug)
                  setName(trimmed)
                  setStep('colors')
                  saveCustomTheme(theme)
                  onPick(theme)
                }}
                onExit={onCancel}
                placeholder="my-theme"
                columns={40}
                cursorOffset={nameCursor}
                onChangeCursorOffset={setNameCursor}
                disableCursorMovementForUpDownKeys
                disableEscapeDoublePress
                focus
                showCursor
              />
            </Box>
            <Text dimColor>
              based on {base} · saved to {getCustomThemesDir()}/{draftSlug}
              .json
            </Text>
          </Box>
          <Text dimColor>
            <Byline>
              {trimmed.length > 0 && (
                <KeyboardShortcutHint shortcut="Enter" action="continue" />
              )}
              <KeyboardShortcutHint shortcut="Esc" action="cancel" />
            </Byline>
          </Text>
        </Box>
      </Pane>
    )
  }

  if (editing !== null) {
    const valid = isThemeColorValue(value)
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold color="permission">
            {name}
          </Text>
          <Box flexDirection="column">
            <Box>
              <Swatch value={valid ? value : preset[editing]} />
              <Text> </Text>
              <Text bold>{editing}</Text>
            </Box>
            <Text dimColor>preset: {preset[editing]}</Text>
          </Box>
          <Box>
            <Text>Value: </Text>
            <TextInput
              value={value}
              onChange={next => {
                setValue(next)
                if (isThemeColorValue(next)) {
                  setCustomThemePreview(slug, { ...overrides, [editing]: next })
                }
              }}
              onSubmit={() => {
                if (!valid) return
                const { [editing]: _, ...rest } = overrides
                save(
                  value === preset[editing]
                    ? rest
                    : { ...overrides, [editing]: value },
                )
                setEditing(null)
              }}
              onExit={cancelEditing}
              placeholder="rgb(r,g,b) · #rrggbb · ansi:red"
              columns={40}
              cursorOffset={valueCursor}
              onChangeCursorOffset={setValueCursor}
              disableCursorMovementForUpDownKeys
              disableEscapeDoublePress
              focus
              showCursor
            />
          </Box>
          <Text dimColor>
            {valid ? (
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="save" />
                <KeyboardShortcutHint shortcut="Esc" action="cancel" />
              </Byline>
            ) : (
              'Accepts rgb(r,g,b), #rrggbb, ansi256(n), or ansi:name'
            )}
          </Text>
        </Box>
      </Pane>
    )
  }

  return (
    <FuzzyPicker
      title={`${name} · based on ${base}`}
      placeholder="Filter color tokens…"
      items={filtered}
      getKey={token => token}
      initialQuery={query}
      onQueryChange={setQuery}
      onSelect={token => {
        const current = currentValue(token)
        setValue(current)
        setValueCursor(current.length)
        setEditing(token)
      }}
      onTab={{
        action: 'reset',
        handler: token => {
          if (!(token in overrides)) return
          const { [token]: _, ...rest } = overrides
          save(rest)
        },
      }}
      onCancel={() => {
        setCustomThemePreview(slug, null)
        onDone({ slug, name, base, overrides })
      }}
      selectAction="edit"
      cancelAction="done"
      matchLabel={
        customizedCount > 0
          ? `${customizedCount} ${plural(customizedCount, 'color')} customized · ${slug}.json`
          : `editing ${slug}.json`
      }
      renderItem={(token, isFocused) => (
        <Box>
          <Swatch value={currentValue(token)} />
          <Text> </Text>
          <Text color={isFocused ? 'suggestion' : undefined}>{token}</Text>
          {token in overrides && <Text dimColor> (custom)</Text>}
        </Box>
      )}
      renderPreview={token => (
        <Box flexDirection="column">
          <Text>
            current: <Swatch value={currentValue(token)} />{' '}
            {currentValue(token)}
          </Text>
          {token in overrides && (
            <Text dimColor>
              preset: <Swatch value={preset[token]} /> {preset[token]}
            </Text>
          )}
        </Box>
      )}
      emptyMessage={q => `No color named "${q}"`}
    />
  )
}

function Swatch({ value }: { value: string }): React.ReactNode {
  return <Text color={value as Color}>██</Text>
}
