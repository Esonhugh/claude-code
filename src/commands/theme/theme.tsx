import * as React from 'react'
import { useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { CustomThemeEditor } from '../../components/CustomThemeEditor.js'
import { Pane } from '../../components/design-system/Pane.js'
import { ThemePicker } from '../../components/ThemePicker.js'
import { useTheme, useThemeSetting } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  type CustomTheme,
  customThemeSetting,
  findCustomTheme,
  parseCustomThemeSetting,
} from '../../utils/customThemes.js'
import { resolveThemeSetting } from '../../utils/systemTheme.js'
import type { ThemeSetting } from '../../utils/theme.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

function themeSetMessage(setting: ThemeSetting): string {
  const slug = parseCustomThemeSetting(setting)
  return slug === null
    ? `Theme set to ${setting}`
    : `Using custom theme "${findCustomTheme(slug)?.name ?? setting}"`
}

function ThemePickerCommand({ onDone }: Props): React.ReactNode {
  const [, setTheme] = useTheme()
  const themeSetting = useThemeSetting()
  const [editor, setEditor] = useState<{ initial?: CustomTheme } | null>(null)

  if (editor) {
    return (
      <CustomThemeEditor
        initial={editor.initial}
        defaultBase={resolveThemeSetting(themeSetting)}
        onPick={theme => setTheme(customThemeSetting(theme.slug))}
        onDone={theme => {
          setTheme(customThemeSetting(theme.slug))
          onDone(`Using custom theme "${theme.name}"`)
        }}
        onCancel={() => setEditor(null)}
      />
    )
  }

  return (
    <Pane color="permission">
      <ThemePicker
        onThemeSelect={setting => {
          setTheme(setting)
          onDone(themeSetMessage(setting))
        }}
        onCustomTheme={theme => {
          if (theme) setTheme(customThemeSetting(theme.slug))
          setEditor({ initial: theme })
        }}
        onCancel={() => {
          onDone('Theme picker dismissed', { display: 'system' })
        }}
        skipExitHandling={true}
      />
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <ThemePickerCommand onDone={onDone} />
}
