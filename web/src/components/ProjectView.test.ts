import { describe, expect, it } from 'bun:test'
import type { T } from './ui'

describe('TaskLink', () => {
  const render = async (props: { title: string; starting?: boolean; activity?: string }) => {
    const react = await import('react')
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { TaskLink } = await import('./ProjectView')
    const html = renderToStaticMarkup(
      react.createElement(TaskLink, {
        t: (key => key) as T,
        task: { id: 'x', title: props.title, state: 'running' },
        starting: props.starting,
        meta: '',
        activity: props.activity ?? '',
        current: false,
      }),
    )
    return html
  }

  it('shows the task as an @ tag', async () => {
    expect(await render({ title: 'Write the tests' })).toContain('<span class="tt">@Write the tests</span>')
  })

  it('leaves the @ off the placeholder before the Agent call names its task (#747)', async () => {
    expect(await render({ title: 'Starting…', starting: true })).toContain('<span class="tt">Starting…</span>')
  })

  it('keeps status separate from a focusable plain-text preview', async () => {
    const html = await render({ title: 'Synthetic task', activity: 'First paragraph\n\n<b>Second paragraph</b>' })
    expect(html).toContain('taskState_running</span></span>')
    expect(html).toMatch(/class="tl-act"[^>]*tabindex="0"/)
    expect(html).toContain('First paragraph\n\n&lt;b&gt;Second paragraph&lt;/b&gt;')
  })
})

describe('task preview ownership', () => {
  it('does not let another badge hover replace the focused badge or body', async () => {
    const { taskPreviewReducer } = await import('./ProjectView')
    const focused = taskPreviewReducer(null, { type: 'focus', id: 'a' })
    expect(focused).toEqual({ id: 'a', focused: true })
    expect(taskPreviewReducer(focused, { type: 'hover', id: 'b' })).toBe(focused)
    expect(taskPreviewReducer(focused, { type: 'leave', id: 'a' })).toBe(focused)
    const blurred = taskPreviewReducer(focused, { type: 'close', id: 'a' })
    expect(taskPreviewReducer(blurred, { type: 'hover', id: 'b' })).toEqual({ id: 'b', focused: false })
  })

  it('switches hover owners without a stale leave or close dismissing the new preview', async () => {
    const { taskPreviewReducer } = await import('./ProjectView')
    const a = taskPreviewReducer(null, { type: 'hover', id: 'a' })
    const b = taskPreviewReducer(a, { type: 'hover', id: 'b' })
    expect(b).toEqual({ id: 'b', focused: false })
    expect(taskPreviewReducer(b, { type: 'leave', id: 'a' })).toBe(b)
    expect(taskPreviewReducer(b, { type: 'close', id: 'a' })).toBe(b)
    expect(taskPreviewReducer(b, { type: 'leave', id: 'b' })).toBeNull()
  })

  it('dismisses the focused preview when another badge is explicitly activated', async () => {
    const { taskPreviewReducer } = await import('./ProjectView')
    const focused = taskPreviewReducer(null, { type: 'focus', id: 'a' })
    expect(taskPreviewReducer(focused, { type: 'activate' })).toBeNull()
  })
})
