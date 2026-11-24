// Applies the saved theme and palette before the page first draws, so a dark or
// mono page does not flash the default colors. A plain script in <head>, not a
// module: the CSP (script-src 'self') allows no inline script. App.tsx owns
// these settings afterwards; the keys and defaults here are the ones there.
;(() => {
  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch {
      return fallback
    }
  }
  const root = document.documentElement
  const theme = read('claude-web-theme', 'system')
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
  const palette = read('claude-web-palette', 'clay')
  if (palette === 'default') delete root.dataset.palette
  else if (palette === 'clay' || palette === 'mono') root.dataset.palette = palette
})()
