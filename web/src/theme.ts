import { useSyncExternalStore } from 'react'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Whether the page shows dark: the theme picked in settings, else the system's. */
export function isDark(): boolean {
  if (typeof document === 'undefined') return false
  const theme = document.documentElement.dataset.theme
  return theme ? theme === 'dark' : matchMedia(DARK_QUERY).matches
}

/** Calls `onChange` when the picked theme or the system's changes; returns the unsubscribe. */
export function onThemeChange(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const media = matchMedia(DARK_QUERY)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  media.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', onChange)
  }
}

export function useDark(): boolean {
  return useSyncExternalStore(onThemeChange, isDark, () => false)
}
