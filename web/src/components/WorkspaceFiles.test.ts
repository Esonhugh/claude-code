import { expect, it } from 'bun:test'
import { listWorkspaceTree } from '../api'
import { WorkspaceFiles } from './WorkspaceFiles'
import type { T } from './ui'

it('renders no branch while inactive; selecting it mounts only the root', async () => {
  const react = await import('react')
  ;(globalThis as { React?: unknown }).React ??= react
  const { renderToStaticMarkup } = await import('react-dom/server')
  const render = (active: boolean) => renderToStaticMarkup(react.createElement(WorkspaceFiles, { scope: { kind: 'project', id: 'test' }, active, t: (key => key) as T }))
  expect(render(false)).toBe('')
  expect(render(true)).toContain('role="status">loading')
  expect(render(true)).not.toContain('workspace-directory')
})

it('isolates the cache by project, session and lifecycle, but not by tab activation', () => {
  const t = ((key: string) => key) as T
  const select = (kind: 'project' | 'session', id: string, active: boolean, sessionMode?: string) =>
    WorkspaceFiles({ scope: { kind, id }, active, sessionMode, t })?.key
  expect(select('project', 'a', true)).toBe('project:a')
  expect(select('project', 'b', true)).toBe('project:b')
  expect(select('session', 'a', true, 'live')).toBe('session:a:live')
  expect(select('session', 'a', false, 'live')).toBe('session:a:live')
  expect(select('session', 'a', true, 'readonly')).toBe('session:a:readonly')
  expect(select('session', 'b', true, 'live')).toBe('session:b:live')
  expect(WorkspaceFiles({ active: true, t })).toBeNull()
})

it('requests a project-scoped directory and forwards cancellation', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  const entries = [{ name: 'readme.md', type: 'file' as const }]
  try {
    globalThis.fetch = Object.assign(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/projects/project-id/tree?dir=one%2Ftwo%20words')
      expect(init.signal).toBe(controller.signal)
      return Response.json({ entries, truncated: true })
    }, { preconnect: original.preconnect }) as typeof fetch
    expect(await listWorkspaceTree({ kind: 'project', id: 'project-id' }, 'one/two words', controller.signal)).toEqual({ entries, truncated: true })
  } finally {
    globalThis.fetch = original
  }
})


it('keeps the Composer key intact and provides the right tab and startup directory copy in all locales', async () => {
  for (const [lang, original] of [['en', 'Workspace files'], ['zh-Hans', '工作区文件'], ['zh-Hant', '工作區檔案']]) {
    const source = await Bun.file(new URL(`../locales/${lang}.json`, import.meta.url)).text()
    const messages = JSON.parse(source) as Record<string, string>
    expect(messages.workspaceFiles).toBe(original)
    for (const key of ['workspaceFiles', 'workspaceFilesTab', 'workspaceTreeStartupCwd', 'workspaceFilesUnavailable', 'workspaceFilesError', 'workspaceFilesEmpty', 'workspaceFilesTruncated']) {
      expect(source.match(new RegExp(`^  "${key}":`, 'gm'))).toHaveLength(1)
      expect(messages[key]).toBeTruthy()
    }
  }
})
