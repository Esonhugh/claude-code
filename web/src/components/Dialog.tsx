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
    if (!closeRef.current?.closest('.dialog')?.contains(document.activeElement)) closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      opener?.focus?.()
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
