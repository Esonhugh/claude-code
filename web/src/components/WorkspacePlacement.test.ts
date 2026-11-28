import { expect, it } from 'bun:test'
import { createElement } from 'react'
import * as react from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { appReducer, initialAppState } from '../store'
import { chatTools } from './Composer'
import { ProjectView } from './ProjectView'
import { Sidebar } from './Sidebar'
import { ProjectWorkspacePanel, SidePanel, type SideTab } from './SidePanel'
import type { T } from './ui'

;(globalThis as { React?: unknown }).React ??= react
const t = ((key: string) => key) as T
const nop = () => {}
const sessionId = 'session-a'
const chat = appReducer(initialAppState, { type: 'mode', id: sessionId, mode: 'readonly' }).chats[sessionId]!
const withReference = {
  ...chat,
  items: [{ kind: 'user' as const, id: 'ref', text: 'Review @/fixture/referenced.md' }],
}
const workspace = { workspaceTreeSupported: true, workspaceTreeScope: { kind: 'session' as const, id: sessionId } }

it('leaves Workspace out of the projects and chats navigation', () => {
  const props = {
    t, lang: 'en' as const, open: true, uiName: 'Fixture', env: {}, history: [], historyMore: false, folders: {},
    running: {}, view: sessionId, searchRef: { current: null }, onNew: nop, onOpen: nop, onPatched: nop,
    onDeleted: nop, onMore: nop, onDialog: nop, account: null, projects: [], onProject: nop, onNewProject: nop,
    onProjectSettings: nop, onProjectChanged: nop, archivedProjects: [], onProjectRestored: nop, ...workspace,
  }
  const html = renderToStaticMarkup(createElement(Sidebar, props))
  expect(html).toContain('class="sessions sidebar open"')
  expect(html).not.toContain('workspace-files')
})

it('keeps Status and session Files, and browses Workspace in the same right panel only when selected', () => {
  const render = (tab: SideTab, supported = true) => renderToStaticMarkup(createElement(SidePanel, {
    t, open: true, tab, setTab: nop, sessionId, chat: withReference, title: 'Fixture', models: [], statusText: 'Idle',
    agentsView: { kind: 'tree' }, setAgentsView: nop, setWorkflowId: nop, onOpenFile: nop, onStopTask: nop,
    onSendTask: async () => {}, agentInput: { model: undefined, effort: undefined, models: [], tools: chatTools(chat, async () => [], [], undefined, nop) }, onRequest: async () => ({}), onModsRequest: async () => ({}),
    onModCanvas: nop, onClose: nop, workspaceTreeSupported: supported,
  }))
  const status = render('status')
  expect(status).toContain('class="side open"')
  expect(status).toContain('status-pane')
  expect(status).toContain('>Files<span class="count">1</span>')
  expect(status).toContain('workspaceFilesTab')
  expect(status).not.toContain('workspace-files')
  const files = render('files')
  expect(files).toContain('title="/fixture/referenced.md"')
  expect(files).not.toContain('workspace-files')
  const tree = render('workspace')
  expect(tree).toMatch(/aria-selected="true"[^>]*>workspaceFilesTab</)
  expect(tree).toContain('aria-labelledby="chat-details-workspace"')
  expect(tree).toContain('workspaceTreeStartupCwd')
  expect(tree).not.toContain('referenced.md')
  expect(render('status', false)).not.toContain('workspaceFilesTab')
})

it('offers Workspace in the project Tasks rail without replacing its initial controls', () => {
  const props = {
    t, project: { id: 'project-a', name: 'Fixture project', cwd: '/fixture', coordinator_session_id: sessionId, instructions: '', worker_model: null, permission_mode: 'default', created_at: 0, updated_at: 0, running: false },
    chat, models: [], menuButton: null, draft: '', setDraft: nop, files: [], setFiles: nop, onSend: nop,
    onStop: nop, onFocus: nop, onQuote: nop, listFiles: async () => [], prompts: [], onMode: nop,
    onModel: nop, onEffort: nop, onContextWindow: nop, onAnswer: nop, onSettings: nop,
    onStopTask: async () => {}, onSendTask: async () => {}, onSendCoordinator: async () => {}, onTasks: nop,
    uploadTo: sessionId, moved: [], onOpenSession: nop, workspaceTreeSupported: true,
  }
  const render = (supported: boolean) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: false }) } })
      return renderToStaticMarkup(createElement(ProjectView, { ...props, workspaceTreeSupported: supported }))
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }
  const html = render(true)
  const [left, right] = html.split('<aside class="pv-side"')
  expect(left).not.toContain('workspaceFilesTab')
  expect(right).toContain('workspaceFilesTab')
  expect(right).toMatch(/aria-selected="true"[^>]*>pvTasks</)
  expect(right).toContain('aria-label="taskBoard"')
  expect(right).not.toContain('workspace-files')
  expect(render(false)).not.toContain('workspaceFilesTab')
})

it('keeps the project-only root disclosure closed in the same right panel', () => {
  const html = renderToStaticMarkup(createElement(ProjectWorkspacePanel, { t, projectId: 'awaiting-coordinator', open: true, onClose: nop }))
  expect(html).toContain('class="side open"')
  expect(html).toMatch(/<details><summary[^>]*>workspaceFilesTab<\/summary>/)
  expect(html).not.toContain('workspace-files')
})
