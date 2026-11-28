import { useEffect, useState } from 'react'

export function useCompactDetailPanel() {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)')
    const update = () => setCompact(query.matches)
    query.addEventListener('change', update)
    update()
    return () => query.removeEventListener('change', update)
  }, [])
  return compact
}

export function DetailTabs<Id extends string>({ panelId, label, tabs, selected, onSelect }: {
  panelId: string
  label: string
  tabs: readonly { id: Id; label: string; count?: number }[]
  selected: Id
  onSelect: (id: Id) => void
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      const last = tabs.length - 1
      const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
        : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
        : event.key === 'End' ? last
        : undefined
      if (next === undefined) return
      event.preventDefault()
      buttons[next]?.focus()
      onSelect(tabs[next]!.id)
    }}>
      {tabs.map(({ id, label, count }) => (
        <button
          role="tab"
          type="button"
          key={id}
          id={`${panelId}-${id}`}
          aria-controls={panelId}
          aria-selected={selected === id}
          tabIndex={selected === id ? 0 : -1}
          onClick={() => onSelect(id)}
        >
          {label}
          {!!count && <span className="count">{count}</span>}
        </button>
      ))}
    </div>
  )
}
