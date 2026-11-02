import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { T } from './ui'

/** The prototype's `.dialog`: centered card, title, close button, scrolling body. */
export function Dialog({
  t,
  title,
  xl,
  onClose,
  children,
}: {
  t: T
  title: ReactNode
  xl?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Read during render: a child with autoFocus takes focus before effects run.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const dialog = closeRef.current?.closest<HTMLElement>('.dialog')
    if (!dialog?.contains(document.activeElement)) closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog answers keys.
      if (dialog !== [...document.querySelectorAll('.dialog')].at(-1)) return
      // A menu open inside the dialog closes on its own Esc first.
      if (e.key === 'Escape' && !dialog?.querySelector('[role="menu"]')) {
        e.stopPropagation()
        onCloseRef.current()
      }
      // Tab and Shift+Tab cycle through the dialog's own controls.
      if (e.key === 'Tab' && dialog) {
        const items = [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')].filter(
          el => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.checkVisibility(),
        )
        const first = items[0]
        const last = items.at(-1)
        const active = document.activeElement
        if (!first || !last) return
        if (!dialog.contains(active) || (e.shiftKey ? active === first : active === last)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first).focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      // An opener in the closed sessions drawer is off screen; the drawer's menu button stands in for it.
      const menuButton = document.querySelector<HTMLElement>('.menu-btn')
      const inClosedDrawer = !!opener?.closest('.sessions:not(.open)') && !!menuButton?.checkVisibility()
      const target = opener?.isConnected && !inClosedDrawer ? opener : menuButton
      target?.focus()
    }
  }, [])
  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={xl ? 'xl' : undefined}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button ref={closeRef} className="btn" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  )
}
