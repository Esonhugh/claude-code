import type { KeyboardEvent, PointerEvent } from 'react'

/** `chat`: the conversation's width while a file preview takes the middle. */
export type Columns = { left?: number; right?: number; chat?: number }
type Side = keyof Columns

/** Keeps the dragged column inside sane bounds and the conversation at least 420px wide. */
export function clampColumn(side: Side, px: number, viewport: number, other: number): number {
  const max = side === 'left' ? 420 : side === 'right' ? 720 : 900
  const min = side === 'left' ? 180 : side === 'right' ? 280 : 340
  return Math.round(Math.max(min, Math.min(max, viewport - other - 420, px)))
}

/**
 * The saved widths as CSS variables, capped by the window: a width dragged on a
 * wide window must not squeeze the conversation after the window gets narrower.
 */
export function columnVars(columns: Columns): Record<string, string> {
  return {
    ...(columns.left && { '--left-w': `min(${columns.left}px, calc(100vw - 700px))` }),
    ...(columns.right && {
      '--right-w': `max(280px, min(${columns.right}px, calc(100vw - var(--left-w, 220px) - 420px)))`,
    }),
    ...(columns.chat && {
      '--chat-w': `max(340px, min(${columns.chat}px, calc(100vw - var(--left-w, 220px) - 420px)))`,
    }),
  }
}

/**
 * The splitter on the left or right edge of the conversation: drag it, or focus it and use ← →;
 * a double click goes back to the default width.
 */
export function ColumnDrag({
  side,
  label,
  columns,
  onChange,
}: {
  side: Side
  label: string
  columns: Columns
  onChange: (next: Columns) => void
}) {
  const selector = { left: '.sessions', right: '.side', chat: '.main' }
  const current = () => {
    const el = document.querySelector<HTMLElement>(selector[side])
    return el?.getBoundingClientRect().width ?? 0
  }
  // The column on the other edge: with a preview open that is the conversation, not the side panel.
  const otherWidth = () => {
    const el = document.querySelector<HTMLElement>(
      side !== 'left' ? '.sessions' : document.body.classList.contains('art') ? '.main' : '.side',
    )
    return el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect().width : 0
  }
  const set = (px: number) => onChange({ ...columns, [side]: clampColumn(side, px, window.innerWidth, otherWidth()) })
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    handle.classList.add('on')
    handle.setPointerCapture(e.pointerId)
    const move = (ev: globalThis.PointerEvent) => set(side === 'left' ? ev.clientX : window.innerWidth - ev.clientX)
    const up = () => {
      handle.classList.remove('on')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const grow = (e.key === 'ArrowRight') === (side === 'left') ? 24 : -24
    set(current() + grow)
  }
  return (
    <div
      className={`col-drag ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(columns[side] ?? current())}
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={key}
      onDoubleClick={() => onChange({ ...columns, [side]: undefined })}
    />
  )
}
