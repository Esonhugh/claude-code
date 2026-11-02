import * as React from 'react'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  Box,
  Text,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from '../ink.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  type CustomTheme,
  customThemeSetting,
  getCustomThemes,
  parseCustomThemeSetting,
  subscribeCustomThemes,
} from '../utils/customThemes.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { ThemeSetting } from '../utils/theme.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { MenuList } from './design-system/MenuList.js'
import {
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from './StructuredDiff/colorDiff.js'
import { StructuredDiff } from './StructuredDiff.js'

export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void
  showIntroText?: boolean
  helpText?: string
  showHelpTextBelow?: boolean
  hideEscToCancel?: boolean
  /** Skip exit handling when running in a context that already has it (e.g., onboarding) */
  skipExitHandling?: boolean
  /** Called when the user cancels (presses Escape). If skipExitHandling is true and this is provided, it will be called instead of just saving the preview. */
  onCancel?: () => void
  /**
   * Enables custom themes: "New custom theme…" calls it with no theme, and
   * ctrl+e on a custom theme calls it with that theme.
   */
  onCustomTheme?: (theme?: CustomTheme) => void
}

const NEW_CUSTOM_THEME = '__new_custom_theme__' as const

export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  skipExitHandling = false,
  onCancel: onCancelProp,
  onCustomTheme,
}: ThemePickerProps): React.ReactNode {
  const [theme] = useTheme()
  const themeSetting = useThemeSetting()
  const { columns } = useTerminalSize()
  const colorModuleUnavailableReason = getColorModuleUnavailableReason()
  const syntaxTheme =
    colorModuleUnavailableReason === null ? getSyntaxTheme(theme) : null
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme()
  const syntaxHighlightingDisabled =
    useAppState(s => s.settings.syntaxHighlightingDisabled) ?? false
  const setAppState = useSetAppState()

  // Register ThemePicker context so its keybindings take precedence over Global
  useRegisterKeybindingContext('ThemePicker')

  const syntaxToggleShortcut = useShortcutDisplay(
    'theme:toggleSyntaxHighlighting',
    'ThemePicker',
    'ctrl+t',
  )

  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      if (colorModuleUnavailableReason === null) {
        const newValue = !syntaxHighlightingDisabled
        updateSettingsForSource('userSettings', {
          syntaxHighlightingDisabled: newValue,
        })
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, syntaxHighlightingDisabled: newValue },
        }))
      }
    },
    { context: 'ThemePicker' },
  )
  // Always call the hook to follow React rules, but conditionally assign the exit handler
  const exitState = useExitOnCtrlCDWithKeybindings(
    skipExitHandling ? () => {} : undefined,
  )

  const customThemes = React.useSyncExternalStore(
    subscribeCustomThemes,
    getCustomThemes,
  )

  const themeOptions: {
    label: string
    value: ThemeSetting | typeof NEW_CUSTOM_THEME
    meta?: string
  }[] = [
    { label: 'Auto (match terminal)', value: 'auto' },
    { label: 'Dark mode', value: 'dark' },
    { label: 'Light mode', value: 'light' },
    {
      label: 'Dark mode (colorblind-friendly)',
      value: 'dark-daltonized',
    },
    {
      label: 'Light mode (colorblind-friendly)',
      value: 'light-daltonized',
    },
    {
      label: 'Dark mode (ANSI colors only)',
      value: 'dark-ansi',
    },
    {
      label: 'Light mode (ANSI colors only)',
      value: 'light-ansi',
    },
    ...customThemes.map(theme => ({
      label: theme.name,
      value: customThemeSetting(theme.slug),
      meta: 'custom',
    })),
    ...(onCustomTheme
      ? [{ label: 'New custom theme…', value: NEW_CUSTOM_THEME }]
      : []),
  ]
  const currentIndex = themeOptions.findIndex(
    option => option.value === themeSetting,
  )
  const [focusedValue, setFocusedValue] = React.useState(
    themeOptions[Math.max(0, currentIndex)]?.value,
  )

  const handleCancel = skipExitHandling
    ? () => {
        cancelPreview()
        onCancelProp?.()
      }
    : async () => {
        cancelPreview()
        await gracefulShutdown(0)
      }

  useKeybindings(
    {
      'select:cancel': () => void handleCancel(),
    },
    { context: 'Select' },
  )

  const editCustomShortcut = useShortcutDisplay(
    'theme:editCustom',
    'ThemePicker',
    'ctrl+e',
  )
  const focusedSlug = focusedValue ? parseCustomThemeSetting(focusedValue) : null
  const focusedCustomTheme = onCustomTheme
    ? customThemes.find(theme => theme.slug === focusedSlug)
    : undefined

  useKeybinding(
    'theme:editCustom',
    () => {
      if (focusedCustomTheme) {
        cancelPreview()
        onCustomTheme?.(focusedCustomTheme)
      }
    },
    { context: 'ThemePicker' },
  )

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        {showIntroText ? (
          <Text>Let&apos;s get started.</Text>
        ) : (
          <Text bold color="permission">
            Theme
          </Text>
        )}
        <Box flexDirection="column">
          <Text bold>
            Choose the text style that looks best with your terminal
          </Text>
          {helpText && !showHelpTextBelow && <Text dimColor>{helpText}</Text>}
        </Box>
        <MenuList
          rows={themeOptions.map(option => ({
            kind: 'item',
            key: option.value,
            icon: option.value === themeSetting ? '✔' : ' ',
            iconColor: 'success',
            label: option.label,
            meta: option.meta ? [option.meta] : [],
          }))}
          visibleItemCount={themeOptions.length}
          defaultFocusIndex={Math.max(0, currentIndex)}
          onFocus={index => {
            const value = themeOptions[index]?.value
            if (value === undefined) return
            setFocusedValue(value)
            if (value === NEW_CUSTOM_THEME) cancelPreview()
            else setPreviewTheme(value)
          }}
          onSelect={index => {
            const value = themeOptions[index]?.value
            if (value === undefined) return
            if (value === NEW_CUSTOM_THEME) {
              cancelPreview()
              onCustomTheme?.()
              return
            }
            savePreview()
            onThemeSelect(value)
          }}
        />
      </Box>
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderStyle="dashed"
          borderColor="subtle"
        >
          <StructuredDiff
            patch={{
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 3,
              lines: [
                ' function greet() {',
                '-  console.log("Hello, World!");',
                '+  console.log("Hello, Claude!");',
                ' }',
              ],
            }}
            dim={false}
            filePath="demo.js"
            firstLine={null}
            width={columns}
          />
        </Box>
        <Text dimColor>
          {' '}
          {colorModuleUnavailableReason === 'env'
            ? `Syntax highlighting disabled (via CLAUDE_CODE_SYNTAX_HIGHLIGHT=${process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT})`
            : syntaxHighlightingDisabled
              ? `Syntax highlighting disabled (${syntaxToggleShortcut} to enable)`
              : syntaxTheme
                ? `Syntax theme: ${syntaxTheme.theme}${syntaxTheme.source ? ` (from ${syntaxTheme.source})` : ''} (${syntaxToggleShortcut} to disable)`
                : `Syntax highlighting enabled (${syntaxToggleShortcut} to disable)`}
        </Text>
      </Box>
    </Box>
  )

  // Only wrap in a box when not in onboarding
  if (!showIntroText) {
    return (
      <>
        <Box flexDirection="column">{content}</Box>
        <Box marginTop={1}>
          {showHelpTextBelow && helpText && (
            <Box marginLeft={3}>
              <Text dimColor>{helpText}</Text>
            </Box>
          )}
          {!hideEscToCancel && (
            <Box>
              <Text dimColor italic>
                {exitState.pending ? (
                  <>Press {exitState.keyName} again to exit</>
                ) : (
                  <Byline>
                    <KeyboardShortcutHint shortcut="Enter" action="select" />
                    {focusedCustomTheme && (
                      <KeyboardShortcutHint
                        shortcut={editCustomShortcut}
                        action="edit"
                      />
                    )}
                    <KeyboardShortcutHint shortcut="Esc" action="cancel" />
                  </Byline>
                )}
              </Text>
            </Box>
          )}
        </Box>
      </>
    )
  }

  return content
}
