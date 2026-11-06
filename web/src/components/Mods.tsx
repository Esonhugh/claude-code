import { type CSSProperties, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n'
import { CodeBlock, Markdown } from '../markdown/Markdown'
import type { ModPane, ModsState, ModToast } from '../protocol'
import type { HostRequest } from './BackgroundPanes'

type T = (key: MessageKey, vars?: Record<string, string>) => string

/** This page's place in the Mods remote UI protocol: one desktop client per session. */
export const MOD_SURFACE = 'desktop'
export const MOD_CLIENT = 'web'

type Handler = { plugin: string; handle: number }
type Node =
  | string
  | {
      type: string
      props?: Record<string, unknown>
      children?: Node[]
      press?: Handler
      client?: { plugin: string }
    }
/** What a drawing asks the session: a press, an input change or submit, a pick. */
type Act = (body: Record<string, unknown>) => void

const INK: Record<string, string> = {
  black: '#1f2328',
  red: '#d1242f',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#a333c8',
  cyan: '#1b7c83',
  white: '#8c959f',
  gray: '#6e7781',
  grey: '#6e7781',
}

/** A terminal colour name, `#hex` or `rgb()`, as CSS; anything else is dropped. */
export function modColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.toLowerCase().replace(/^ansi:/, '').replace(/bright$/, '')
  if (INK[name]) return `var(--mod-${name}, ${INK[name]})`
  if (/^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\([\d\s.,%]+\)$/i.test(value)) return value
  return undefined
}

/** Cells across (`ch`) or rows down (`em`, a line each); a percentage stays one. */
const across = (n: unknown) => (typeof n === 'number' ? `${n}ch` : typeof n === 'string' && /^\d+(\.\d+)?%$/.test(n) ? n : undefined)
const down = (n: unknown) => (typeof n === 'number' ? `${n * 1.45}em` : typeof n === 'string' && /^\d+(\.\d+)?%$/.test(n) ? n : undefined)
const keyword = (v: unknown, allowed: string[]) => (typeof v === 'string' && allowed.includes(v) ? v : undefined)

/** A Box's or Text's props as CSS, the way Ink lays them out. */
export function modStyle(type: string, p: Record<string, unknown> = {}): CSSProperties {
  const style: CSSProperties = {}
  const box = type === 'Box' || type === 'div'
  if (box) {
    const column = p.flexDirection === 'column' || p.flexDirection === 'column-reverse'
    Object.assign(style, {
      display: p.display === 'none' ? 'none' : 'flex',
      flexDirection: keyword(p.flexDirection, ['row', 'column', 'row-reverse', 'column-reverse']) ?? 'row',
      flexWrap: keyword(p.flexWrap, ['wrap', 'nowrap', 'wrap-reverse']),
      alignItems: keyword(p.alignItems, ['flex-start', 'center', 'flex-end', 'stretch', 'baseline']),
      alignSelf: keyword(p.alignSelf, ['flex-start', 'center', 'flex-end', 'stretch', 'auto']),
      justifyContent: keyword(p.justifyContent, ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']),
      flexGrow: typeof p.flexGrow === 'number' ? p.flexGrow : undefined,
      flexShrink: typeof p.flexShrink === 'number' ? p.flexShrink : undefined,
      width: across(p.width),
      minWidth: across(p.minWidth),
      height: down(p.height),
      minHeight: down(p.minHeight),
      columnGap: across(p.columnGap ?? p.gap),
      rowGap: down(p.rowGap ?? p.gap),
      overflow: p.overflow === 'hidden' ? 'hidden' : undefined,
    })
    if (column && p.gap !== undefined && p.rowGap === undefined) style.rowGap = down(p.gap)
    for (const [side, css] of [['Top', 'Top'], ['Bottom', 'Bottom'], ['Left', 'Left'], ['Right', 'Right']] as const) {
      const vertical = side === 'Top' || side === 'Bottom'
      const pad = p[`padding${side}`] ?? (vertical ? p.paddingY : p.paddingX) ?? p.padding
      const mar = p[`margin${side}`] ?? (vertical ? p.marginY : p.marginX) ?? p.margin
      if (pad !== undefined) style[`padding${css}`] = vertical ? down(pad) : across(pad)
      if (mar !== undefined) style[`margin${css}`] = vertical ? down(mar) : across(mar)
    }
    if (typeof p.borderStyle === 'string') {
      style.border = `1px ${p.borderStyle === 'double' ? 'double' : 'solid'} ${modColor(p.borderColor) ?? 'var(--line)'}`
      style.borderRadius = p.borderStyle === 'round' ? 8 : 2
      style.padding ??= '0.2em 0.6ch'
    }
  }
  const bg = modColor(p.backgroundColor)
  if (bg) style.background = bg
  const fg = modColor(p.color)
  if (fg) style.color = fg
  if (p.bold) style.fontWeight = 600
  if (p.italic) style.fontStyle = 'italic'
  const lines = [p.underline && 'underline', p.strikethrough && 'line-through'].filter(Boolean)
  if (lines.length) style.textDecoration = lines.join(' ')
  if (p.dimColor) style.opacity = 0.6
  if (p.inverse) Object.assign(style, { background: fg ?? 'var(--fg)', color: bg ?? 'var(--surface)' })
  if (type === 'Text' && (p.wrap === 'truncate' || p.wrap === 'truncate-end')) {
    Object.assign(style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  }
  return style
}

export function safeModLink(href: unknown): href is string {
  if (typeof href !== 'string') return false
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)
  } catch {
    return false
  }
}

function ModInput({ node, act }: { node: Extract<Node, object>; act: Act }) {
  const p = node.props ?? {}
  const [value, setValue] = useState(typeof p.value === 'string' ? p.value : '')
  // A redraw that carries a new value (the Mod set it) replaces what was typed.
  useEffect(() => setValue(typeof p.value === 'string' ? p.value : ''), [p.value])
  const send = (kind: 'change' | 'submit', v: string) => act({ subtype: 'ui_input', kind, value: v, key: p.key, ...node.press })
  return (
    <form
      className="mod-input"
      onSubmit={e => {
        e.preventDefault()
        send('submit', value)
      }}
    >
      {typeof p.label === 'string' && <span className="mod-label">{p.label}</span>}
      <input
        value={value}
        placeholder={typeof p.placeholder === 'string' ? p.placeholder : undefined}
        autoFocus={p.autoFocus === true}
        onChange={e => {
          setValue(e.target.value)
          send('change', e.target.value)
        }}
      />
      {typeof p.submitLabel === 'string' && (
        <button type="submit" className="btn">
          {p.submitLabel}
        </button>
      )}
    </form>
  )
}

function ModSelect({ node, act }: { node: Extract<Node, object>; act: Act }) {
  const p = node.props ?? {}
  const options = (Array.isArray(p.options) ? p.options : []).filter(
    (o): o is { value: string; label?: string } => !!o && typeof (o as { value?: unknown }).value === 'string',
  )
  const [value, setValue] = useState(typeof p.value === 'string' ? p.value : options[0]?.value)
  useEffect(() => {
    if (typeof p.value === 'string') setValue(p.value)
  }, [p.value])
  return (
    <div className="mod-select" role="listbox" aria-label={typeof p.label === 'string' ? p.label : undefined}>
      {typeof p.label === 'string' && <span className="mod-label">{p.label}</span>}
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="option"
          aria-selected={o.value === value}
          className={o.value === value ? 'btn on' : 'btn'}
          onClick={() => {
            setValue(o.value)
            act({ subtype: 'ui_select', value: o.value, key: p.key, ...node.press })
          }}
        >
          {o.label ?? o.value}
        </button>
      ))}
    </div>
  )
}

/** One element of a Mod's drawing, as the wire tree describes it. */
export function ModNode({ node, act, t }: { node: Node; act: Act; t: T }): ReactNode {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return null
  const p = node.props ?? {}
  const kids = (node.children ?? []).map((c, i) => <ModNode key={i} node={c} act={act} t={t} />)
  switch (node.type) {
    case 'Box':
    case 'div':
      return <div style={modStyle(node.type, p)}>{kids}</div>
    case 'Text':
    case 'span':
      return <span style={modStyle('Text', p)}>{kids}</span>
    case 'b':
      return <b>{kids}</b>
    case 'Button':
      return (
        <button
          type="button"
          className={p.variant === 'primary' ? 'btn primary mod-btn' : 'btn mod-btn'}
          style={p.dimColor ? { opacity: 0.6 } : undefined}
          title={typeof p.hotkey === 'string' ? p.hotkey : undefined}
          onClick={() => act({ subtype: 'ui_press', key: p.key, ...node.press })}
        >
          {String(p.label ?? '')}
        </button>
      )
    case 'Input':
      return <ModInput node={node} act={act} />
    case 'Select':
      return <ModSelect node={node} act={act} />
    case 'Link':
      return safeModLink(p.href) ? (
        <a href={p.href} target="_blank" rel="noopener noreferrer">
          {kids.length ? kids : String(p.label ?? p.href)}
        </a>
      ) : (
        <span>{kids.length ? kids : String(p.label ?? '')}</span>
      )
    case 'Code':
      return <CodeBlock code={String(p.source ?? '')} lang={typeof p.language === 'string' ? p.language : null} streaming={false} />
    case 'Markdown': {
      const pressable = Array.isArray(p.pressableLinks) ? p.pressableLinks : []
      return (
        <div
          className="mod-md"
          style={p.dimColor ? { opacity: 0.6 } : undefined}
          onClickCapture={e => {
            const href = (e.target as Element).closest('a')?.getAttribute('href')
            if (!href || !node.press || !pressable.includes(href)) return
            e.preventDefault()
            act({ subtype: 'ui_press', href, key: p.key, ...node.press })
          }}
        >
          <Markdown text={String(p.text ?? '')} />
        </div>
      )
    }
    case 'Svg':
      return typeof p.source === 'string' ? (
        <img
          className="mod-svg"
          // An <img> runs no script the SVG carries.
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.source)}`}
          alt={String(p.alt ?? '')}
          width={typeof p.width === 'number' ? p.width : undefined}
          height={typeof p.height === 'number' ? p.height : undefined}
        />
      ) : null
    case 'Client':
      return <span className="mod-note">{t('modClientView')}</span>
    default:
      // `engine`: the session's own drawing, which this page has nothing more for.
      return null
  }
}

type Grid = { columns: number; rows: number }

/** The cells a box holds, measured in the page's monospace font, as a terminal would count them. */
function useGrid(box: RefObject<HTMLElement | null>, rows?: number): Grid | undefined {
  const [grid, setGrid] = useState<Grid>()
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const probe = document.createElement('span')
    probe.className = 'mod-cell-probe'
    probe.textContent = '0'.repeat(10)
    el.appendChild(probe)
    const cell = probe.getBoundingClientRect()
    probe.remove()
    const cw = cell.width / 10 || 8
    const ch = cell.height || 18
    let timer = 0
    const measure = () => {
      const r = el.getBoundingClientRect()
      const next = {
        columns: Math.max(10, Math.floor(r.width / cw)),
        rows: rows ?? Math.max(4, Math.floor((r.height || window.innerHeight * 0.6) / ch)),
      }
      setGrid(g => (g && g.columns === next.columns && g.rows === next.rows ? g : next))
    }
    measure()
    const sized = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = window.setTimeout(measure, 120)
    })
    sized.observe(el)
    return () => {
      clearTimeout(timer)
      sized.disconnect()
    }
  }, [box, rows])
  return grid
}

/**
 * A Mod's drawing of one render site (`Pane`, `AbovePrompt`), asked of the session and drawn
 * again whenever the session says it changed or the space it has does.
 */
export function ModView({
  request,
  component,
  instanceId,
  mods,
  t,
  rows,
  className,
  onEmpty,
}: {
  request: HostRequest
  component: 'Pane' | 'AbovePrompt'
  instanceId: string
  mods: ModsState
  t: T
  rows?: number
  className?: string
  /** Told whether the site drew anything, so its frame can hide. */
  onEmpty?: (empty: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const grid = useGrid(box, rows)
  const [tree, setTree] = useState<Node | null>()
  const [error, setError] = useState<string>()
  const seq = (mods.seq[`${component}:${instanceId}`] ?? 0) + (mods.seq['*'] ?? 0)
  const latest = useRef(0)
  useEffect(() => {
    if (!grid) return
    const mine = ++latest.current
    request({
      subtype: 'ui_render',
      surface: MOD_SURFACE,
      client_id: MOD_CLIENT,
      component,
      instance_id: instanceId,
      props: {},
      viewport: grid,
    }).then(
      res => {
        if (mine !== latest.current) return
        setError(undefined)
        const next = (res.tree ?? null) as Node | null
        setTree(next)
        onEmpty?.(!next || (typeof next === 'object' && next.type === 'engine'))
      },
      (err: unknown) => {
        if (mine !== latest.current) return
        setError(err instanceof Error ? err.message : String(err))
        onEmpty?.(true)
      },
    )
  }, [request, component, instanceId, seq, grid, onEmpty])
  const act: Act = body => {
    void request({ surface: MOD_SURFACE, client_id: MOD_CLIENT, component, instance_id: instanceId, ...body }).catch(
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    )
  }
  return (
    <div ref={box} className={`mod-view ${className ?? ''}`}>
      {error && component === 'Pane' && <div className="mod-note">{error}</div>}
      {tree && <ModNode node={tree} act={act} t={t} />}
      {tree === undefined && !error && component === 'Pane' && <div className="mod-note">{t('loading')}</div>}
    </div>
  )
}

/** The side panel's Mods tab: each plugin's status entry, then every pane a Mod opened. */
export function ModsTab({
  mods,
  request,
  t,
  canvasId,
  onCanvas,
}: {
  mods: ModsState
  request: HostRequest
  t: T
  canvasId?: string
  onCanvas: (pane: ModPane) => void
}) {
  const status = Object.entries(mods.status)
  return (
    <div className="mods-tab">
      {status.length > 0 && (
        <section className="mod-status">
          {status.map(([plugin, text]) => (
            <div key={plugin}>
              <span className="mono mod-plugin">{plugin}</span> {text}
            </div>
          ))}
        </section>
      )}
      {!mods.panes.length && !status.length && <p className="note">{t('modsNone')}</p>}
      {mods.panes.map(pane => (
        <section key={pane.id} className="mod-pane">
          <header>
            <b>{pane.title}</b>
            <span className="mono mod-plugin">{pane.plugin}</span>
            <button type="button" className="btn" onClick={() => onCanvas(pane)} disabled={canvasId === pane.id}>
              {t('modOpenCanvas')}
            </button>
          </header>
          {canvasId === pane.id ? (
            <p className="note">{t('modOnCanvas')}</p>
          ) : (
            <ModView request={request} component="Pane" instanceId={pane.id} mods={mods} t={t} rows={pane.rows ?? 16} />
          )}
        </section>
      ))}
    </div>
  )
}

/** Toasts a Mod raised, each for its own time; a click puts one away early. */
export function ModToasts({ toasts }: { toasts: ModToast[] }) {
  const [now, setNow] = useState(() => Date.now())
  const [gone, setGone] = useState<string[]>([])
  const live = toasts.filter(x => x.at + x.timeoutMs > now && !gone.includes(x.id))
  const next = Math.min(...live.map(x => x.at + x.timeoutMs))
  useEffect(() => {
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(50, next - Date.now()))
    return () => clearTimeout(timer)
  }, [next, toasts])
  useEffect(() => setNow(Date.now()), [toasts])
  if (!live.length) return null
  return (
    <div className="mod-toasts" role="status" aria-live="polite">
      {live.map(x => (
        <button key={x.id} type="button" className="mod-toast" onClick={() => setGone(g => [...g, x.id])}>
          <span className="mono mod-plugin">{x.plugin}</span> {x.text}
        </button>
      ))}
    </div>
  )
}

/** A Mod's pane on the canvas, the column a file preview takes. */
export function ModCanvas({
  pane,
  id,
  mods,
  request,
  t,
  onClose,
}: {
  pane?: ModPane
  id: string
  mods?: ModsState
  request: HostRequest
  t: T
  onClose: () => void
}) {
  return (
    <aside className="preview mod-canvas" aria-label={pane?.title ?? id}>
      <div className="arthead preview-bar">
        <span className="kind mono">MOD</span>
        <span className="nm">
          <b className="mono preview-name">{pane?.title ?? id}</b>
          {pane && <small className="mono">{pane.plugin}</small>}
        </span>
        <span className="grp" style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn" aria-label={t('close')} onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      <div className="artbody preview-body">
        {pane && mods ? (
          <ModView request={request} component="Pane" instanceId={id} mods={mods} t={t} className="mod-canvas-view" />
        ) : (
          <div className="preview-note">{t('modPaneClosed')}</div>
        )}
      </div>
    </aside>
  )
}
