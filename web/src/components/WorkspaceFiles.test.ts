import { expect, it } from 'bun:test'
import { listWorkspaceTree } from '../api'
import { WorkspaceFiles } from './WorkspaceFiles'
import type { T } from './ui'

it('renders a collapsed workspace foldout without directory rows', async () => {
  const react = await import('react')
  ;(globalThis as { React?: unknown }).React ??= react
  const { renderToStaticMarkup } = await import('react-dom/server')
  const markup = renderToStaticMarkup(react.createElement(WorkspaceFiles, { scope: { kind: 'project', id: 'test' }, supported: true, t: (key => key) as T }))
  expect(markup).toContain('aria-expanded="false"')
  expect(markup).toContain('sbWorkspaceFiles')
  expect(markup).not.toContain('workspace-files-body')
  expect(markup).not.toContain('role="tree"')
})

it('does not share a mounted foldout between project selections or unsupported connections', () => {
  const t = ((key: string) => key) as T
  const select = (projectId?: string, supported?: boolean) => WorkspaceFiles({ scope: projectId ? { kind: 'project', id: projectId } : undefined, supported, t })
  expect(select('project-a', true)?.key).toBe('project:project-a')
  expect(select('project-b', true)?.key).toBe('project:project-b')
  expect(select('project-a', false)).toBeNull()
  expect(select('project-a')).toBeNull()
  expect(select(undefined, true)).toBeNull()
  const scope = { kind: 'session' as const, id: 'project-a' }
  expect(WorkspaceFiles({ scope, supported: true, sessionMode: 'live', t })?.key).toBe('session:project-a:live')
  expect(WorkspaceFiles({ scope, supported: true, sessionMode: 'readonly', t })?.key).toBe('session:project-a:readonly')
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


it('keeps the Composer key intact and gives the sidebar one valid key per locale', async () => {
  for (const [lang, original] of [['en', 'Workspace files'], ['zh-Hans', '工作区文件'], ['zh-Hant', '工作區檔案']]) {
    const source = await Bun.file(new URL(`../locales/${lang}.json`, import.meta.url)).text()
    const messages = JSON.parse(source) as Record<string, string>
    expect(messages.workspaceFiles).toBe(original)
    for (const key of ['workspaceFiles', 'sbWorkspaceFiles', 'sbWorkspaceStartupCwd', 'workspaceFilesUnavailable', 'workspaceFilesError', 'workspaceFilesEmpty', 'workspaceFilesTruncated']) {
      expect(source.match(new RegExp(`^  "${key}":`, 'gm'))).toHaveLength(1)
      expect(messages[key]).toBeTruthy()
    }
  }
})
