import React, {
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Except } from 'type-fest'
import type { DOMElement } from '../dom.js'
import type { ClickEvent } from '../events/click-event.js'
import type { FocusEvent } from '../events/focus-event.js'
import type { KeyboardEvent } from '../events/keyboard-event.js'
import type { Styles } from '../styles.js'
import Box from './Box.js'
import { ClockContext } from './ClockContext.js'
import { logForDebugging } from '../../utils/debug.js'

type ButtonState = {
  focused: boolean
  hovered: boolean
  active: boolean
}

export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>
  /**
   * Called when the button is activated via Enter, Space, or click.
   */
  onAction: () => void
  /**
   * Tab order index. Defaults to 0 (in tab order).
   * Set to -1 for programmatically focusable only.
   */
  tabIndex?: number
  mountSettleMs?: number
  /**
   * Focus this button when it mounts.
   */
  autoFocus?: boolean
  /**
   * Called when this button receives keyboard focus.
   */
  onFocus?: (event: FocusEvent) => void
  /**
   * Render prop receiving the interactive state. Use this to
   * style children based on focus/hover/active — Button itself
   * is intentionally unstyled.
   *
   * If not provided, children render as-is (no state-dependent styling).
   */
  children: ((state: ButtonState) => React.ReactNode) | React.ReactNode
}

function Button({
  onAction,
  tabIndex = 0,
  autoFocus,
  mountSettleMs = 300,
  onFocus,
  children,
  ref,
  ...style
}: Props): React.ReactNode {
  const clock = useContext(ClockContext)
  const [mountedAt] = useState(() => clock?.now() ?? performance.now())
  const [isFocused, setIsFocused] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isActive, setIsActive] = useState(false)

  const activeTimer = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      activeTimer.current?.()
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'return' || e.key === ' ') {
        e.preventDefault()
        setIsActive(true)
        onAction()
        activeTimer.current?.()
        if (clock) activeTimer.current = clock.setTimeout(() => setIsActive(false), 100)
        else {
          const timer = setTimeout(() => setIsActive(false), 100)
          activeTimer.current = () => clearTimeout(timer)
        }
      }
    },
    [clock, onAction],
  )

  const handleClick = useCallback(
    (event: ClickEvent) => {
      const elapsedMs = (clock?.now() ?? performance.now()) - mountedAt
      const stray = event.isWindowActivation || elapsedMs < mountSettleMs
      logForDebugging(`[InkButton] ${JSON.stringify({ event: 'click', elapsedMs, mountSettleMs,
        isWindowActivation: event.isWindowActivation, disposition: stray ? 'stray' : 'activate',
        col: event.col, row: event.row })}`)
      if (stray) {
        event.dropAsStray()
        return
      }
      onAction()
    },
    [clock, mountedAt, mountSettleMs, onAction],
  )

  const handleFocus = useCallback(
    (event: FocusEvent) => {
      setIsFocused(true)
      onFocus?.(event)
    },
    [onFocus],
  )
  const handleBlur = useCallback((_e: FocusEvent) => setIsFocused(false), [])
  const handleMouseEnter = useCallback(() => setIsHovered(true), [])
  const handleMouseLeave = useCallback(() => setIsHovered(false), [])

  const state: ButtonState = {
    focused: isFocused,
    hovered: isHovered,
    active: isActive,
  }
  const content = typeof children === 'function' ? children(state) : children

  return (
    <Box
      ref={ref}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...style}
    >
      {content}
    </Box>
  )
}

export default Button
export type { ButtonState }
