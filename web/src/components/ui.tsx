import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  { key: 'default', mark: '○', label: 'manual mode on', desc: 'modeDescDefault' },
  { key: 'acceptEdits', mark: '⏵⏵', label: 'accept edits on', desc: 'modeDescAcceptEdits' },
  { key: 'plan', mark: '⏸', label: 'plan mode on', desc: 'modeDescPlan' },
  { key: 'auto', mark: '⏵⏵', label: 'auto mode on', desc: 'modeDescAuto' },
  { key: 'bypassPermissions', mark: '⏵⏵', label: 'bypass permissions on', desc: 'modeDescBypass' },
]

export const modeOf = (key: string | undefined) => MODES.find(m => m.key === key) ?? MODES[0]!

/** The modes to offer: plan mode only when settings allow it (`planModeAvailable`) or it is on, like the TUI. */
export const offeredModes = (plan: boolean | undefined, key?: string) =>
  MODES.filter(m => m.key !== 'plan' || plan || key === 'plan')

/** Next mode for Shift+Tab, as the TUI cycles. */
export const nextMode = (key: string | undefined, plan?: boolean) => {
  const modes = offeredModes(plan)
  return modes[(modes.indexOf(modeOf(key)) + 1) % modes.length]!.key
}

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
  fixed,
  label,
  children,
}: {
  button: ReactNode
  buttonClass?: string
  buttonProps?: Record<string, string | undefined>
  menuClass?: string
  wrapId?: string
  right?: boolean
  /** Placed against the viewport, on the side with more room: a scrolling box (a dialog body) would clip it. */
  fixed?: boolean
  label?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!open || !fixed) return
    const update = () => {
      const r = wrap.current?.querySelector('.footbtn')?.getBoundingClientRect()
      if (!r) return
      const above = r.top - 8
      const below = window.innerHeight - r.bottom - 8
      const up = above >= below
      setPlace({
        position: 'fixed',
        ...(right ? { left: 'auto', right: window.innerWidth - r.right } : { left: r.left }),
        ...(up ? { top: 'auto', bottom: window.innerHeight - r.top + 6 } : { bottom: 'auto', top: r.bottom + 6 }),
        maxHeight: Math.min(440, (up ? above : below) - 6),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, fixed, right])
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
        <div className={`${menuClass}${right ? ' right' : ''}`} role="menu" style={fixed ? place : undefined}>
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

/** How far the conversation is from auto-compact (the threshold, not the window). */
export function compactHint(t: T, total: number, threshold: number, fmt: (n: number) => string): string {
  return total < threshold ? t('compactIn', { n: fmt(threshold - total) }) : t('compactDue')
}

/**
 * Whether a feed keeps following new output after a scroll event. Scroll events arrive a frame
 * late, after more of a reply may have rendered: only scrolling up (the reader's own move)
 * unsticks, and reaching the bottom sticks again.
 */
export function followScroll(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  following: boolean,
  lastTop: { current: number },
): boolean {
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  const up = el.scrollTop < lastTop.current
  lastTop.current = el.scrollTop
  return atEnd || (following && !up)
}
