import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import chokidar from 'chokidar'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCustomThemes,
  getCustomThemesDir,
  reloadCustomThemes,
  saveCustomTheme,
  setCustomThemePreview,
  subscribeCustomThemes,
  uniqueCustomThemeSlug,
  watchCustomThemes,
} from './customThemes.js'
import { resolveThemeSetting } from './systemTheme.js'
import { getBuiltinTheme, getTheme, isThemeColorValue } from './theme.js'

const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'custom-themes-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
  reloadCustomThemes()
})

test('theme color values accept the official formats only', () => {
  for (const ok of ['rgb(1,2,3)', 'rgb(1, 2, 3)', '#a1b2c3', '#abc', 'ansi256(42)', 'ansi:redBright']) {
    expect(isThemeColorValue(ok)).toBe(true)
  }
  for (const bad of ['red', 'rgb(1,2)', '#abcd', 'ansi:purple', 'ansi256(x)', 42]) {
    expect(isThemeColorValue(bad)).toBe(false)
  }
})

test('a saved custom theme renders as its base plus valid overrides', () => {
  saveCustomTheme({
    slug: 'ocean',
    name: 'Ocean',
    base: 'light',
    overrides: { claude: '#123456' },
  })
  expect(JSON.parse(readFileSync(join(getCustomThemesDir(), 'ocean.json'), 'utf8'))).toEqual({
    name: 'Ocean',
    base: 'light',
    overrides: { claude: '#123456' },
  })

  const palette = getTheme('custom:ocean')
  expect(palette.claude).toBe('#123456')
  expect(palette.text).toBe(getBuiltinTheme('light').text)
  expect(resolveThemeSetting('custom:ocean')).toBe('light')
})

test('theme files drop unknown tokens, bad colors and bad bases', () => {
  mkdirSync(getCustomThemesDir(), { recursive: true })
  writeFileSync(
    join(getCustomThemesDir(), 'messy.json'),
    JSON.stringify({ name: 'Messy', base: 'neon', overrides: { claude: 'blue', nope: '#fff', error: 'ansi:red' } }),
  )
  writeFileSync(join(getCustomThemesDir(), 'broken.json'), '{')
  const themes = reloadCustomThemes()
  expect(themes.map(theme => theme.slug)).toEqual(['messy', 'ocean'])
  expect(themes[0]).toEqual({ slug: 'messy', name: 'Messy', base: 'dark', overrides: { error: 'ansi:red' } })
})

test('a missing custom theme falls back to dark', () => {
  expect(getTheme('custom:gone')).toEqual(getBuiltinTheme('dark'))
  expect(resolveThemeSetting('custom:gone')).toBe('dark')
})

test('editor previews apply until cleared', () => {
  setCustomThemePreview('ocean', { claude: 'ansi:green' })
  expect(getTheme('custom:ocean').claude).toBe('ansi:green')
  setCustomThemePreview('ocean', null)
  expect(getTheme('custom:ocean').claude).toBe('#123456')
})

test('slugs are file-name safe and unique', () => {
  const themes = reloadCustomThemes()
  expect(uniqueCustomThemeSlug('My Theme!', themes)).toBe('my-theme')
  expect(uniqueCustomThemeSlug('Ocean', themes)).toBe('ocean-2')
  expect(uniqueCustomThemeSlug('***', themes)).toBe('theme')
})

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await Bun.sleep(100)
  expect(check()).toBe(true)
}

async function startWatching() {
  mkdirSync(getCustomThemesDir(), { recursive: true })
  const probe = join(getCustomThemesDir(), 'probe.txt')
  rmSync(probe, { force: true })
  reloadCustomThemes()
  const watch = spyOn(chokidar, 'watch')
  const stop = watchCustomThemes()
  const watcher = watch.mock.results[0]!.value as ReturnType<typeof chokidar.watch>
  const options = watch.mock.calls[0]![1]
  watch.mockRestore()
  const close = async () => {
    stop()
    await watcher.close()
  }
  try {
    await new Promise<void>(resolve => watcher.once('ready', resolve))
    // chokidar reports `ready` before the poller has taken its first reading of
    // the directory, and a file created before that reading is never reported.
    // Create a file that is not a theme until the watcher reports it, so that
    // the steps below start with the poller running.
    let polling = false
    watcher.on('add', path => {
      if (path.endsWith('probe.txt')) polling = true
    })
    for (let attempt = 0; attempt < 10 && !polling; attempt++) {
      rmSync(probe, { force: true })
      writeFileSync(probe, 'probe')
      for (let i = 0; i < 20 && !polling; i++) await Bun.sleep(100)
    }
    expect(polling).toBe(true)
  } catch (error) {
    await close()
    throw error
  }
  return { options, close }
}

test('files added, edited, atomically replaced or removed reload the themes', async () => {
  const { options, close } = await startWatching()
  const file = join(getCustomThemesDir(), 'by-hand.json')
  try {
    expect(options).toMatchObject({ usePolling: true, interval: 500 })
    writeFileSync(file, JSON.stringify({ name: 'By hand', base: 'light', overrides: {} }))
    await waitFor(() => getCustomThemes().some(theme => theme.name === 'By hand'))
    writeFileSync(file, JSON.stringify({ name: 'Edited', base: 'light', overrides: { claude: '#123456' } }))
    // Use an exactly representable timestamp so the rename does not move mtime.
    const timestamp = Math.ceil(Date.now() / 1000) + 1
    utimesSync(file, timestamp, timestamp)
    await waitFor(() => getCustomThemes().some(theme => theme.name === 'Edited'))
    // Renaming a non-theme staging file over the JSON must invalidate the cached palette.
    expect(getTheme('custom:by-hand').claude).toBe('#123456')
    const original = statSync(file)
    const staging = join(configDir, 'by-hand.tmp')
    writeFileSync(staging, readFileSync(file, 'utf8').replace('#123456', '#654321'))
    utimesSync(staging, original.atime, original.mtime)
    renameSync(staging, file)
    const replacement = statSync(file)
    expect(replacement.ino).not.toBe(original.ino)
    expect(replacement.size).toBe(original.size)
    expect(replacement.mtimeMs).toBe(original.mtimeMs)
    await waitFor(() => getTheme('custom:by-hand').claude === '#654321')
    rmSync(file)
    await waitFor(() => !getCustomThemes().some(theme => theme.slug === 'by-hand'))
  } finally {
    await close()
  }
}, 30_000)

test('a new theme file reloads the themes once', async () => {
  const { close } = await startWatching()
  let reloads = 0
  const unsubscribe = subscribeCustomThemes(() => reloads++)
  try {
    writeFileSync(
      join(getCustomThemesDir(), 'once.json'),
      JSON.stringify({ name: 'Once', base: 'light', overrides: {} }),
    )
    await waitFor(() => getCustomThemes().some(theme => theme.name === 'Once'))
    // Long enough for a second reload scheduled by the directory event to run.
    await Bun.sleep(1000)
    expect(reloads).toBe(1)
  } finally {
    unsubscribe()
    await close()
  }
}, 30_000)

test('a theme file that is still being written is not read', async () => {
  const { close } = await startWatching()
  const file = join(getCustomThemesDir(), 'slow.json')
  const body = JSON.stringify({ name: 'Slow', base: 'light', overrides: { claude: '#123456' } })
  const written: string[] = []
  // Creating the file is the only directory event; the rest of the write
  // lasts several times longer than the watcher waits for a file to settle.
  writeFileSync(file, '')
  const unsubscribe = subscribeCustomThemes(() => written.push(readFileSync(file, 'utf8')))
  try {
    for (let i = 0; i < body.length; i += 2) {
      await Bun.sleep(50)
      appendFileSync(file, body.slice(i, i + 2))
    }
    await waitFor(() => getCustomThemes().some(theme => theme.name === 'Slow'))
    expect(written.filter(text => text !== body)).toEqual([])
  } finally {
    unsubscribe()
    await close()
  }
}, 30_000)
