import type { Lang } from '../i18n'
import type { Z } from './zhText'

/** A control request to the open session (mcp_status, reload_plugins…), when one is running. */
export type Control = (body: Record<string, unknown>) => Promise<Record<string, unknown>>

export type ExtProps = {
  z: Z
  lang: Lang
  /** The prototype's bottom toast. */
  flash: (text: string) => void
  control?: Control
}

export function Switch({
  on,
  label,
  disabled,
  title,
  onToggle,
}: {
  on: boolean
  label: string
  disabled?: boolean
  title?: string
  onToggle: () => void
}) {
  return (
    <button
      className="switch"
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
    />
  )
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
