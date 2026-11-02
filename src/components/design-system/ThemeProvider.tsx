import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import useStdin from '../../ink/hooks/use-stdin.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  subscribeCustomThemes,
  watchCustomThemes,
} from '../../utils/customThemes.js'
import {
  getSystemThemeName,
  type SystemTheme,
} from '../../utils/systemTheme.js'
import type {
  ResolvedTheme,
  ThemeName,
  ThemeSetting,
} from '../../utils/theme.js'

type ThemeContextValue = {
  /** The saved user preference. May be 'auto'. */
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
  /** The resolved theme to render with. Never 'auto'. */
  currentTheme: ResolvedTheme
}

// Non-'auto' default so useTheme() works without a provider (tests, tooling).
const DEFAULT_THEME: ThemeName = 'dark'

const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  currentTheme: DEFAULT_THEME,
})

type Props = {
  children: React.ReactNode
  initialState?: ThemeSetting
  onThemeSave?: (setting: ThemeSetting) => void
}

function defaultInitialTheme(): ThemeSetting {
  return getGlobalConfig().theme
}

function defaultSaveTheme(setting: ThemeSetting): void {
  saveGlobalConfig(current => ({ ...current, theme: setting }))
}

export function ThemeProvider({
  children,
  initialState,
  onThemeSave = defaultSaveTheme,
}: Props) {
  const [themeSetting, setThemeSetting] = useState(
    initialState ?? defaultInitialTheme,
  )
  const [previewTheme, setPreviewTheme] = useState<ThemeSetting | null>(null)

  // Track terminal theme for 'auto' resolution. Seeds from $COLORFGBG (or
  // 'dark' if unset); the OSC 11 watcher corrects it on first poll.
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(() =>
    (initialState ?? themeSetting) === 'auto' ? getSystemThemeName() : 'dark',
  )

  // The setting currently in effect (preview wins while picker is open)
  const activeSetting = previewTheme ?? themeSetting

  const { internal_querier } = useStdin()

  // Watch for live terminal theme changes while 'auto' is active.
  useEffect(() => {
    if (activeSetting !== 'auto' || !internal_querier) return
    let cleanup: (() => void) | undefined
    let cancelled = false
    void import('../../utils/systemThemeWatcher.js').then(
      ({ watchSystemTheme }) => {
        if (cancelled) return
        cleanup = watchSystemTheme(internal_querier, setSystemTheme)
      },
    )
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [activeSetting, internal_querier])

  // Re-render when a custom theme is saved, edited on disk or previewed in
  // the editor.
  const [customThemesVersion, setCustomThemesVersion] = useState(0)
  useEffect(
    () => subscribeCustomThemes(() => setCustomThemesVersion(v => v + 1)),
    [],
  )
  useEffect(() => watchCustomThemes(), [])

  const currentTheme: ResolvedTheme =
    activeSetting === 'auto' ? systemTheme : activeSetting

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeSetting,
      setThemeSetting: (newSetting: ThemeSetting) => {
        setThemeSetting(newSetting)
        setPreviewTheme(null)
        // Switching to 'auto' restarts the watcher (activeSetting dep), whose
        // first poll fires immediately. Seed from the cache so the OSC
        // round-trip doesn't flash the wrong palette.
        if (newSetting === 'auto') {
          setSystemTheme(getSystemThemeName())
        }
        onThemeSave?.(newSetting)
      },
      setPreviewTheme: (newSetting: ThemeSetting) => {
        setPreviewTheme(newSetting)
        if (newSetting === 'auto') {
          setSystemTheme(getSystemThemeName())
        }
      },
      savePreview: () => {
        if (previewTheme !== null) {
          setThemeSetting(previewTheme)
          setPreviewTheme(null)
          onThemeSave?.(previewTheme)
        }
      },
      cancelPreview: () => {
        if (previewTheme !== null) {
          setPreviewTheme(null)
        }
      },
      currentTheme,
    }),
    // customThemesVersion: a new context value re-renders theme consumers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeSetting, previewTheme, currentTheme, onThemeSave, customThemesVersion],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * Returns the resolved theme for rendering (never 'auto') and a setter that
 * accepts any ThemeSetting (including 'auto').
 */
export function useTheme(): [ResolvedTheme, (setting: ThemeSetting) => void] {
  const { currentTheme, setThemeSetting } = useContext(ThemeContext)
  return [currentTheme, setThemeSetting]
}

/**
 * Returns the raw theme setting as stored in config. Use this in UI that
 * needs to show 'auto' as a distinct choice (e.g., ThemePicker).
 */
export function useThemeSetting(): ThemeSetting {
  return useContext(ThemeContext).themeSetting
}

export function usePreviewTheme() {
  const { setPreviewTheme, savePreview, cancelPreview } =
    useContext(ThemeContext)
  return { setPreviewTheme, savePreview, cancelPreview }
}
