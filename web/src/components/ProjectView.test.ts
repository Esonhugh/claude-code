import { describe, expect, it } from 'bun:test'
import type { T } from './ui'

describe('TaskLink', () => {
  const render = async (props: { title: string; starting?: boolean }) => {
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
        activity: '',
        current: false,
      }),
    )
    return html.match(/<span class="tt">(.*?)<\/span>/)?.[1]
  }

  it('shows the task as an @ tag', async () => {
    expect(await render({ title: 'Write the tests' })).toBe('@Write the tests')
  })

  it('leaves the @ off the placeholder before the Agent call names its task (#747)', async () => {
    expect(await render({ title: 'Starting…', starting: true })).toBe('Starting…')
  })
})
