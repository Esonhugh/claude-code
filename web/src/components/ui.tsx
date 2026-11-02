import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n'

export type T = (key: MessageKey, vars?: Record<string, string>) => string

/** The pixel crab from the prototype's sidebar head and start page. */
export function Clawd() {
  return (
    <svg className="clawd" viewBox="0 0 9 6" shapeRendering="crispEdges" aria-hidden="true">
      <g fill="#d97757">
        <rect x="1" y="0" width="7" height="1" />
        <rect x="1" y="1" width="1" height="1" />
        <rect x="3" y="1" width="3" height="1" />
        <rect x="7" y="1" width="1" height="1" />
        <rect x="0" y="2" width="9" height="1" />
        <rect x="1" y="3" width="7" height="1" />
        <rect x="1" y="4" width="1" height="1" />
        <rect x="3" y="4" width="1" height="1" />
        <rect x="5" y="4" width="1" height="1" />
        <rect x="7" y="4" width="1" height="1" />
      </g>
    </svg>
  )
}

export function SendIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  )
}

/**
 * Permission modes as the TUI names them; the labels stay English in every
 * language, like the prototype. Only the one-line descriptions translate.
 */
export const MODES: { key: string; mark: string; label: string; desc: MessageKey }[] = [
  { key: 'default', mark: '○', label: 'default mode', desc: 'modeDescDefault' },
  { key: 'acceptEdits', mark: '⏵⏵', label: 'accept edits on', desc: 'modeDescAcceptEdits' },
  { key: 'plan', mark: '⏸', label: 'plan mode on', desc: 'modeDescPlan' },
  { key: 'auto', mark: '⏵⏵', label: 'auto mode on', desc: 'modeDescAuto' },
  { key: 'bypassPermissions', mark: '⏵⏵', label: 'bypass permissions on', desc: 'modeDescBypass' },
]

export const modeOf = (key: string | undefined) => MODES.find(m => m.key === key) ?? MODES[0]!

/** Next mode for Shift+Tab, as the TUI cycles. */
export const nextMode = (key: string | undefined) =>
  MODES[(MODES.indexOf(modeOf(key)) + 1) % MODES.length]!.key

/**
 * A `.footbtn` with its `.pop` menu: one open at a time, closed by Esc or a
 * click outside.
 */
export function FootMenu({
  button,
  buttonClass = '',
  buttonProps,
  menuClass = 'pop footmenu',
  wrapId,
  right,
  label,
  children,
}: {
  button: ReactNode
  buttonClass?: string
  buttonProps?: Record<string, string | undefined>
  menuClass?: string
  wrapId?: string
  right?: boolean
  label?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        // Focus inside the menu would be lost when it unmounts.
        if (wrap.current?.contains(document.activeElement)) wrap.current.querySelector<HTMLElement>('.footbtn')?.focus()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className={`footwrap${right ? ' right' : ''}`} id={wrapId} ref={wrap}>
      <button
        type="button"
        className={`footbtn ${buttonClass}`.trim()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
        {...buttonProps}
      >
        {button}
      </button>
      {open && (
        <div className={`${menuClass}${right ? ' right' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function readStored<V>(key: string, fallback: V): V {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as V) : fallback
  } catch {
    return fallback
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not persisted; fine for a per-browser convenience.
  }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
