import {
  Component,
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  baseName,
  extension,
  fileNeighbors,
  filesBase,
  fileUrl,
  parseCsv,
  previewKind,
  type SessionFile,
} from '../files'
import type { MessageKey } from '../i18n'
import { CodeBlock, Markdown } from '../markdown/Markdown'

type T = (key: MessageKey, vars?: Record<string, string>) => string

const TEXT_BYTES = 1024 * 1024
const TEXT_LINES = 2000
const SHEET_ROWS = 500

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (!res.ok) throw new HttpError(res.status)
  return res
}

/** The first megabyte and `lines` lines as text, or the whole file without `lines`; `truncated` when the file is longer. */
async function fetchText(url: string, lines?: number): Promise<{ text: string; truncated: boolean }> {
  if (lines === undefined) return { text: await (await fetchOk(url)).text(), truncated: false }
  const res = await fetchOk(url, { headers: { Range: `bytes=0-${TEXT_BYTES - 1}` } })
  const total = Number(res.headers.get('content-range')?.split('/')[1] ?? 0)
  const text = await res.text()
  const split = text.split('\n')
  return split.length > lines
    ? { text: split.slice(0, lines).join('\n'), truncated: true }
    : { text, truncated: res.status === 206 && total > TEXT_BYTES }
}

function useLoad<V>(load: () => Promise<V>, deps: unknown[]) {
  const [state, setState] = useState<{ value?: V; error?: unknown }>({})
  useEffect(() => {
    let live = true
    setState({})
    load().then(
      value => live && setState({ value }),
      (error: unknown) => live && setState({ error }),
    )
    return () => {
      live = false
    }
  }, deps)
  return state
}

let purifyReady: Promise<typeof import('dompurify').default> | undefined
const purify = () => (purifyReady ??= import('dompurify').then(m => m.default))

/** Sanitized HTML in a sandboxed frame: no scripts, an opaque origin, no cookies. */
function HtmlFrame({ html, width }: { html: string; width?: number }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    let url: string | undefined
    let live = true
    void purify().then(p => {
      if (!live) return
      const clean = p.sanitize(html, { WHOLE_DOCUMENT: true })
      url = URL.createObjectURL(new Blob([clean], { type: 'text/html' }))
      setSrc(url)
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [html])
  return src ? (
    <iframe
      className="preview-frame"
      title="preview"
      sandbox=""
      src={src}
      style={width ? { width } : undefined}
    />
  ) : null
}

function SvgImage({ url, name }: { url: string; name: string }) {
  const { value, error } = useLoad(async () => {
    const [text, p] = await Promise.all([fetchText(url), purify()])
    const clean = p.sanitize(text.text, { USE_PROFILES: { svg: true, svgFilters: true } })
    return URL.createObjectURL(new Blob([clean], { type: 'image/svg+xml' }))
  }, [url])
  useEffect(
    () => () => {
      if (value) URL.revokeObjectURL(value)
    },
    [value],
  )
  if (error) throw error
  return value ? (
    <Pinnable>
      <img className="preview-image" src={value} alt={name} />
    </Pinnable>
  ) : null
}

/** Where on the file a comment points. */
export type Anchor =
  /** A pinned spot: fractions of the width and height, and the PDF page. */
  | { kind: 'spot'; x: number; y: number; page?: number }
  /** Selected lines of a text or code view, from 1. */
  | { kind: 'lines'; from: number; to: number }
  /** Selected text of a rendered document; `line` when the source has it exactly once, `page` on a PDF page or slide. */
  | { kind: 'quote'; quote: string; line?: number; page?: number }
  /** A table cell, `B3` as a spreadsheet names it. */
  | { kind: 'cell'; ref: string; sheet?: string }
type Sent = { anchor: Anchor; text: string }
/** An anchor waiting for its comment; `at` places the box in the viewer, except for spots. */
type Draft = { anchor: Anchor; at?: { left: number; top: number } }

const pct = (n: number) => Math.round(n * 100)
const QUOTE_CHARS = 120

/** The message a comment sends, in the shape claude.ai uses: `Comment on <target> (<where>): <text>`. */
export function commentText(target: string, anchor: Anchor, text: string): string {
  let where: string
  switch (anchor.kind) {
    case 'spot':
      where = `${anchor.page ? `page ${anchor.page}, ` : ''}pinned at ${pct(anchor.x)}% from the left, ${pct(anchor.y)}% from the top`
      break
    case 'lines':
      where = anchor.from === anchor.to ? `line ${anchor.from}` : `lines ${anchor.from}-${anchor.to}`
      break
    case 'quote': {
      const flat = anchor.quote.replace(/\s+/g, ' ').trim()
      const quote = flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat
      where = `${anchor.page ? `page ${anchor.page}, ` : ''}${anchor.line ? `line ${anchor.line}, ` : ''}on "${quote}"`
      break
    }
    case 'cell':
      where = `${anchor.sheet ? `sheet "${anchor.sheet}", ` : ''}cell ${anchor.ref}`
  }
  return `Comment on ${target} (${where}): ${text.trim()}`
}

/** The line a quote starts on in the source, when its first line occurs there exactly once. */
export function quoteLine(source: string, quote: string): number | undefined {
  const first = quote.split('\n').find(l => l.trim())?.trim()
  if (!first) return undefined
  const at = source.indexOf(first)
  if (at < 0 || source.indexOf(first, at + 1) >= 0) return undefined
  return source.slice(0, at).split('\n').length
}

/** `A`, …, `Z`, `AA` for a 0-based column. */
export function columnName(n: number): string {
  let name = ''
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + ((i - 1) % 26)) + name
  return name
}

const PinContext = createContext<
  | {
      sent: Sent[]
      draft?: Draft
      place: (draft: Draft) => void
      /** Offers a Comment button for a text selection; undefined takes it away. */
      offer: (draft: Draft | undefined) => void
      submit: (text: string) => void
      cancel: () => void
      t: T
    }
  | undefined
>(undefined)

/** A box's place in the viewer's scrolled content, just under `rect`. */
function below(el: Element, rect: DOMRect) {
  const body = el.closest('.preview-body')
  if (!body) return undefined
  const view = body.getBoundingClientRect()
  return { left: rect.left - view.left + body.scrollLeft, top: rect.bottom - view.top + body.scrollTop }
}

function CommentBox({
  style,
  t,
  onSubmit,
  onCancel,
}: {
  style: CSSProperties
  t: T
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [shift, setShift] = useState(0)
  const box = useRef<HTMLFormElement>(null)
  // Opens below its anchor, nudged sideways to stay inside the viewer, and scrolled into view.
  useLayoutEffect(() => {
    const el = box.current
    const view = el?.closest('.preview-body')?.getBoundingClientRect()
    if (!el || !view) return
    const r = el.getBoundingClientRect()
    setShift(Math.max(view.left + 8 - r.left, Math.min(0, view.right - 8 - r.right)))
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])
  const send = () => text.trim() && onSubmit(text)
  return (
    <form
      ref={box}
      className="cpin-box"
      style={{ ...style, transform: `translateX(${shift}px)` }}
      onClick={e => e.stopPropagation()}
      onMouseUp={e => e.stopPropagation()}
      onSubmit={e => {
        e.preventDefault()
        send()
      }}
    >
      <textarea
        autoFocus
        rows={3}
        aria-label={t('pinComment')}
        placeholder={t('pinPlaceholder')}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            // Only the box closes, not the preview.
            e.nativeEvent.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      <span className="btns">
        <button type="button" className="btn" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={!text.trim()}>
          {t('send')}
        </button>
      </span>
    </form>
  )
}

const pinAt = (s: { x: number; y: number }) => ({ left: `${s.x * 100}%`, top: `${s.y * 100}%` })

/** The spot a click on `box` points at, or nothing when the click ends a text selection. */
function spotIn(box: Element, e: { clientX: number; clientY: number }, page?: number): Anchor | undefined {
  if (window.getSelection()?.isCollapsed === false) return undefined
  const r = box.getBoundingClientRect()
  if (!r.width || !r.height) return undefined
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  return { kind: 'spot', x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height), page }
}

/** The numbered marks of sent pins on one page (or image), and the pin being written. */
function PinMarks({ page }: { page?: number }) {
  const pin = useContext(PinContext)
  if (!pin) return null
  const spots = pin.sent.flatMap(p => (p.anchor.kind === 'spot' ? [{ ...p.anchor, text: p.text }] : []))
  const draft = pin.draft?.anchor.kind === 'spot' && pin.draft.anchor.page === page ? pin.draft.anchor : undefined
  return (
    <>
      {spots.map((p, i) =>
        p.page === page ? (
          <span key={i} className="cpin sent" style={pinAt(p)} title={p.text} onClick={e => e.stopPropagation()}>
            {i + 1}
          </span>
        ) : null,
      )}
      {draft && (
        <>
          <span className="cpin" style={pinAt(draft)}>
            {spots.length + 1}
          </span>
          <CommentBox key={`${draft.x},${draft.y}`} style={pinAt(draft)} t={pin.t} onSubmit={pin.submit} onCancel={pin.cancel} />
        </>
      )}
    </>
  )
}

/** Wraps an image or PDF page so a click drops a pin there; sent pins stay as numbered marks. */
function Pinnable({ page, children }: { page?: number; children: ReactNode }) {
  const pin = useContext(PinContext)
  if (!pin) return <>{children}</>
  return (
    <div
      className="pinnable"
      title={pin.draft ? undefined : pin.t('pinHint')}
      onClick={e => {
        const anchor = spotIn(e.currentTarget, e, page)
        if (anchor) pin.place({ anchor })
      }}
    >
      {children}
      <PinMarks page={page} />
    </div>
  )
}

/**
 * Text the reader can select to comment on. With `lines` the text is shown as written (a code
 * view), so the selection's offset counts lines; otherwise the selection is quoted, with the
 * line from `source` when it is found there once.
 */
function Selectable({
  lines,
  source,
  pageOf,
  children,
}: {
  lines?: boolean
  source?: string
  /** The PDF page or slide a node is on. */
  pageOf?: (node: Node) => number | undefined
  children: ReactNode
}) {
  const pin = useContext(PinContext)
  const root = useRef<HTMLDivElement>(null)
  if (!pin) return <>{children}</>
  return (
    <div
      ref={root}
      className="selectable"
      onMouseUp={() => {
        const el = root.current
        const sel = window.getSelection()
        const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : undefined
        // The selection's text, unlike the range's, breaks lines between blocks (a heading and its paragraph).
        const quote = range ? sel!.toString() : ''
        if (!el || !range || !quote.trim() || !el.contains(range.commonAncestorContainer)) {
          pin.offer(undefined)
          return
        }
        let anchor: Anchor
        if (lines) {
          const code = el.querySelector('.codeblock-body') ?? el
          const before = document.createRange()
          before.setStart(code, 0)
          before.setEnd(range.startContainer, range.startOffset)
          const from = before.toString().split('\n').length
          anchor = { kind: 'lines', from, to: from + quote.replace(/\n+$/, '').split('\n').length - 1 }
        } else {
          anchor = {
            kind: 'quote',
            quote,
            line: source === undefined ? undefined : quoteLine(source, quote),
            page: pageOf?.(range.startContainer),
          }
        }
        const rects = range.getClientRects()
        const at = below(el, rects[rects.length - 1] ?? range.getBoundingClientRect())
        if (at) pin.offer({ anchor, at })
      }}
    >
      {children}
    </div>
  )
}

type PdfDoc = import('pdfjs-dist').PDFDocumentProxy

let pdfReady: Promise<typeof import('pdfjs-dist')> | undefined
const pdfjs = () =>
  (pdfReady ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  }))

/** The page being read: the last one whose top has passed a third of the way down the view. */
export function readingPage(tops: number[], viewTop: number, viewHeight: number): number {
  const line = viewTop + viewHeight / 3
  let page = 1
  tops.forEach((top, i) => {
    if (top <= line) page = i + 1
  })
  return page
}

/** The PDF page or slide (counted from 1) a node is on. */
function pageOf(node: Node): number | undefined {
  const el = node instanceof Element ? node : node.parentElement
  const pdf = el?.closest<HTMLElement>('[data-page]')
  if (pdf) return Number(pdf.dataset.page)
  const slide = el?.closest<HTMLElement>('[data-slide-index]')
  return slide ? Number(slide.dataset.slideIndex) + 1 : undefined
}

/** One page, drawn when it comes near the view; until then a blank of the first page's shape. */
function PdfPage({ doc, n, width, aspect }: { doc: PdfDoc; n: number; width: number; aspect: number }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el || near) return
    const seen = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setNear(true)
    }, { root: el.closest('.preview-body'), rootMargin: '800px 0px' })
    seen.observe(el)
    return () => seen.disconnect()
  }, [near])

  useEffect(() => {
    if (!near || !width) return
    let task: { cancel: () => void } | undefined
    let words: { cancel: () => void } | undefined
    let live = true
    void Promise.all([doc.getPage(n), pdfjs()]).then(([p, lib]) => {
      const el = canvas.current
      if (!live || !el) return
      const base = p.getViewport({ scale: 1 })
      const ratio = window.devicePixelRatio || 1
      const viewport = p.getViewport({ scale: (width / base.width) * ratio })
      el.width = viewport.width
      el.height = viewport.height
      el.style.width = `${viewport.width / ratio}px`
      const render = p.render({ canvas: el, viewport })
      task = render
      render.promise.then(() => live && setDrawn(true), () => {})
      // Invisible text over the canvas, so a passage can be selected and commented on.
      const layer = text.current
      if (!layer) return
      const css = p.getViewport({ scale: width / base.width })
      layer.replaceChildren()
      layer.style.setProperty('--total-scale-factor', String(css.scale))
      const textLayer = new lib.TextLayer({ textContentSource: p.streamTextContent(), container: layer, viewport: css })
      words = textLayer
      textLayer.render().catch(() => {})
    })
    return () => {
      live = false
      task?.cancel()
      words?.cancel()
    }
  }, [doc, n, width, near])

  return (
    <div className="pdf-page" ref={box} data-page={n} style={drawn ? undefined : { width, height: width * aspect }}>
      <Pinnable page={n}>
        <canvas ref={canvas} hidden={!drawn} />
        <div className="textLayer" ref={text} hidden={!drawn} />
      </Pinnable>
    </div>
  )
}

/** Every page in one column that scrolls up and down; the pager shows and jumps to the page being read. */
function PdfView({ url, t }: { url: string; t: T }) {
  const [doc, setDoc] = useState<PdfDoc>()
  const [error, setError] = useState<unknown>()
  const [aspect, setAspect] = useState(1.414)
  const [width, setWidth] = useState(0)
  const [page, setPage] = useState(1)
  const [input, setInput] = useState('1')
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    let destroy: (() => Promise<void>) | undefined
    setDoc(undefined)
    setError(undefined)
    setPage(1)
    pdfjs().then(
      lib => {
        if (!live) return
        const task = lib.getDocument({ url })
        destroy = () => task.destroy()
        task.promise.then(
          d => {
            if (!live) return
            void d.getPage(1).then(p => {
              const v = p.getViewport({ scale: 1 })
              if (live) setAspect(v.height / v.width)
            })
            setDoc(d)
          },
          (err: unknown) => live && setError(err),
        )
      },
      (err: unknown) => live && setError(err),
    )
    return () => {
      live = false
      void destroy?.()
    }
  }, [url])

  // Page width follows the panel; the page number follows the scroll.
  useEffect(() => {
    const el = root.current
    if (!doc || !el) return
    const scroller = el.closest('.preview-body') ?? el
    const measure = () => {
      const cs = getComputedStyle(el)
      setWidth(Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)))
    }
    const onScroll = () => {
      const view = scroller.getBoundingClientRect()
      const tops = [...el.querySelectorAll('.pdf-page')].map(p => p.getBoundingClientRect().top)
      setPage(readingPage(tops, view.top, view.height))
    }
    measure()
    const sized = new ResizeObserver(measure)
    sized.observe(el)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      sized.disconnect()
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [doc])

  useEffect(() => setInput(String(page)), [page])

  const go = (n: number) => {
    root.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' })
    setPage(n)
  }

  if (error) throw error
  if (!doc) return <div className="preview-note">{t('loading')}</div>
  return (
    <Selectable pageOf={pageOf}>
      <div className="pdf" ref={root}>
        <div className="pager">
          <button
            type="button"
            className="ghost"
            aria-label={t('prevPage')}
            disabled={page <= 1}
            onClick={() => go(page - 1)}
          >
            ‹
          </button>
          <input
            aria-label={t('page')}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              const n = Number(input)
              if (Number.isInteger(n) && n >= 1 && n <= doc.numPages) go(n)
              else setInput(String(page))
            }}
          />
          <span className="page-count">/ {doc.numPages}</span>
          <button
            type="button"
            className="ghost"
            aria-label={t('nextPage')}
            disabled={page >= doc.numPages}
            onClick={() => go(page + 1)}
          >
            ›
          </button>
        </div>
        {Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={i + 1} doc={doc} n={i + 1} width={width} aspect={aspect} />
        ))}
      </div>
    </Selectable>
  )
}

type Cell = import('exceljs').CellValue

function cellText(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value !== 'object') return String(value)
  if ('richText' in value) return value.richText.map(r => r.text).join('')
  if ('result' in value) return cellText(value.result as Cell)
  if ('text' in value) return String(value.text)
  if ('error' in value) return String(value.error)
  return ''
}

function ShowAll({ onClick, t }: { onClick: () => void; t: T }) {
  return (
    <button type="button" className="preview-more" onClick={onClick}>
      {t('showAll')}
    </button>
  )
}

function Table({ rows, sheet }: { rows: string[][]; sheet?: string }) {
  const pin = useContext(PinContext)
  const sent = new Map(
    pin?.sent.flatMap(p => (p.anchor.kind === 'cell' && p.anchor.sheet === sheet ? [[p.anchor.ref, p.text]] : [])),
  )
  const draft = pin?.draft?.anchor.kind === 'cell' && pin.draft.anchor.sheet === sheet ? pin.draft.anchor.ref : undefined
  return (
    <div className="sheet">
      <table className={pin ? 'commentable' : undefined}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => {
                const ref = `${columnName(j)}${i + 1}`
                const Cell = i === 0 ? 'th' : 'td'
                return (
                  <Cell
                    key={j}
                    className={ref === draft ? 'cell-draft' : sent.has(ref) ? 'cell-sent' : undefined}
                    title={sent.get(ref)}
                    onClick={
                      pin &&
                      (e => {
                        if (!window.getSelection()?.isCollapsed) return
                        const at = below(e.currentTarget, e.currentTarget.getBoundingClientRect())
                        if (at) pin.place({ anchor: { kind: 'cell', ref, sheet }, at })
                      })
                    }
                  >
                    {cell}
                  </Cell>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function XlsxView({ url, t }: { url: string; t: T }) {
  const [sheet, setSheet] = useState(0)
  const [all, setAll] = useState(false)
  const { value: book, error } = useLoad(async () => {
    const [res, ExcelJS] = await Promise.all([fetchOk(url), import('exceljs')])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    return wb
  }, [url])
  const table = useMemo(() => {
    const ws = book?.worksheets[sheet]
    if (!ws) return undefined
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: true }, row => {
      if (!all && rows.length >= SHEET_ROWS) return
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      rows.push(values.map(v => cellText(v as Cell)))
    })
    return { rows, total: ws.rowCount }
  }, [book, sheet, all])
  if (error) throw error
  if (!book || !table) return <div className="preview-note">{t('loading')}</div>
  return (
    <>
      <div className="sheettabs" role="tablist">
        {book.worksheets.map((ws, i) => (
          <button
            type="button"
            role="tab"
            key={ws.id}
            aria-selected={i === sheet}
            onClick={() => {
              setSheet(i)
              setAll(false)
            }}
          >
            {ws.name}
          </button>
        ))}
      </div>
      <Table rows={table.rows} sheet={book.worksheets[sheet]?.name} />
      {table.total > table.rows.length && <ShowAll onClick={() => setAll(true)} t={t} />}
    </>
  )
}

function DocxView({ url, t }: { url: string; t: T }) {
  const { value, error } = useLoad(async () => {
    const [res, mammoth, p] = await Promise.all([fetchOk(url), import('mammoth'), purify()])
    const out = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() })
    // The `{ __html }` object stays the same across renders, so React leaves the page (and a selection) alone.
    return { __html: p.sanitize(out.value) }
  }, [url])
  if (error) throw error
  if (value === undefined) return <div className="preview-note">{t('loading')}</div>
  return (
    <Selectable>
      <div
        className="docx-page"
        // DOMPurify-sanitized output of mammoth.
        dangerouslySetInnerHTML={value}
      />
    </Selectable>
  )
}

/** Links a slide may keep: absolute web and mail ones (a deck can name any URL, `javascript:` included). */
export function safeSlideLink(href: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)
  } catch {
    return false
  }
}

/** Slides drawn in the browser, for a .pptx the server has no soffice to convert (#909). */
function SlidesView({ url, t }: { url: string; t: T }) {
  const pin = useContext(PinContext)
  const box = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  // Bumped as slides mount, so the pins over them are placed again.
  const [, setMounted] = useState(0)
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    const el = box.current
    if (!el) return
    let live = true
    let viewer: { destroy: () => void } | undefined
    setReady(false)
    setError(undefined)
    Promise.all([fetchOk(url), import('@aiden0z/pptx-renderer')])
      .then(async ([res, lib]) => {
        const data = await res.arrayBuffer()
        if (!live) return
        const opened = await lib.PptxViewer.open(data, el, {
          zipLimits: lib.RECOMMENDED_ZIP_LIMITS,
          // Nothing is fetched on the deck's behalf, and no PDF.js comes from a CDN.
          externalMedia: 'block',
          pdfjs: false,
          scrollContainer: el.closest<HTMLElement>('.preview-body') ?? undefined,
          onSlideRendered: (_, slide) => {
            for (const a of slide.querySelectorAll('a[href]')) {
              if (!safeSlideLink(a.getAttribute('href') ?? '')) a.removeAttribute('href')
            }
            setMounted(n => n + 1)
          },
          onSlideUnmounted: () => setMounted(n => n + 1),
        })
        if (live) {
          viewer = opened
          setReady(true)
        } else opened.destroy()
      })
      .catch((err: unknown) => live && setError(err))
    return () => {
      live = false
      viewer?.destroy()
    }
  }, [url])
  if (error) throw error
  return (
    <>
      {!ready && <div className="preview-note">{t('loading')}</div>}
      <Selectable pageOf={pageOf}>
        <div
          className={pin ? 'slides-pins pinning' : 'slides-pins'}
          title={pin && !pin.draft ? pin.t('pinHint') : undefined}
          onClick={e => {
            const target = e.target as Element
            const slide = target.closest<HTMLElement>('[data-slide-index]')
            const frame = slide?.firstElementChild
            if (!pin || !slide || !frame || target.closest('a[href], .cpin, .cpin-box')) return
            const anchor = spotIn(frame, e, Number(slide.dataset.slideIndex) + 1)
            if (anchor) pin.place({ anchor })
          }}
        >
          <div className="slides" ref={box} />
          <SlidePins box={box} />
        </div>
      </Selectable>
    </>
  )
}

/** Pin marks laid over the slides that have them; the renderer owns the slides' own DOM. */
function SlidePins({ box }: { box: RefObject<HTMLDivElement | null> }) {
  const pin = useContext(PinContext)
  const [, setSize] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const sized = new ResizeObserver(() => setSize(n => n + 1))
    sized.observe(el)
    return () => sized.disconnect()
  }, [box])
  const el = box.current
  const host = el?.parentElement?.getBoundingClientRect()
  if (!pin || !el || !host) return null
  const pages = new Set(
    [...pin.sent, ...(pin.draft ? [pin.draft] : [])].flatMap(p =>
      p.anchor.kind === 'spot' && p.anchor.page ? [p.anchor.page] : [],
    ),
  )
  return [...pages].map(page => {
    const frame = el.querySelector(`[data-slide-index="${page - 1}"] > div`)
    if (!frame) return null
    const r = frame.getBoundingClientRect()
    return (
      <div
        key={page}
        className="slide-pins"
        style={{ left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height }}
      >
        <PinMarks page={page} />
      </div>
    )
  })
}

/** A .pptx: the soffice PDF when the server can convert it, otherwise the slides drawn here. */
function PptxView({ sessionId, path, t }: { sessionId: string; path: string; t: T }) {
  const pdf = fileUrl(sessionId, path, { pdf: true })
  const { value: converted, error } = useLoad(async () => {
    // A one-byte GET: a HEAD would be turned away for carrying no Origin.
    const res = await fetch(pdf, { headers: { Range: 'bytes=0-0' } })
    void res.body?.cancel()
    if (res.status === 501) return false
    if (!res.ok) throw new HttpError(res.status)
    return true
  }, [pdf])
  if (error) throw error
  if (converted === undefined) return <div className="preview-note">{t('loading')}</div>
  return converted ? <PdfView url={pdf} t={t} /> : <SlidesView url={fileUrl(sessionId, path)} t={t} />
}

function TextView({
  url,
  render,
  t,
  lines = TEXT_LINES,
}: {
  url: string
  render: (text: string) => ReactNode
  t: T
  lines?: number
}) {
  const [all, setAll] = useState(false)
  const { value, error } = useLoad(() => fetchText(url, all ? undefined : lines), [url, all, lines])
  if (error) throw error
  if (!value) return <div className="preview-note">{t('loading')}</div>
  return (
    <>
      {render(value.text)}
      {value.truncated && <ShowAll onClick={() => setAll(true)} t={t} />}
    </>
  )
}

const WIDTHS = [
  { key: 'widthDesktop', width: undefined },
  { key: 'widthTablet', width: 768 },
  { key: 'widthPhone', width: 390 },
  { key: 'htmlSource', width: 'source' },
] as const
/** A frame width, or the page's source to comment on by line. */
type HtmlView = number | 'source' | undefined

function Body({
  sessionId,
  path,
  t,
  htmlWidth,
}: {
  sessionId: string
  path: string
  t: T
  htmlWidth?: HtmlView
}) {
  const url = fileUrl(sessionId, path)
  const name = baseName(path)
  switch (previewKind(path)) {
    case 'image':
      return (
        <Pinnable>
          <img className="preview-image" src={url} alt={name} />
        </Pinnable>
      )
    case 'svg':
      return <SvgImage url={url} name={name} />
    case 'pdf':
      return <PdfView url={url} t={t} />
    case 'office':
      return extension(path) === 'pptx' ? (
        <PptxView sessionId={sessionId} path={path} t={t} />
      ) : (
        <PdfView url={fileUrl(sessionId, path, { pdf: true })} t={t} />
      )
    case 'xlsx':
      return <XlsxView url={url} t={t} />
    case 'docx':
      return <DocxView url={url} t={t} />
    case 'markdown':
      return (
        <TextView
          url={url}
          t={t}
          render={text => (
            <Selectable source={text}>
              <Markdown text={text} filesBase={filesBase(sessionId)} />
            </Selectable>
          )}
        />
      )
    case 'html':
      return (
        <TextView
          url={url}
          t={t}
          render={text =>
            htmlWidth === 'source' ? (
              <Selectable lines>
                <CodeBlock code={text} lang="html" streaming={false} />
              </Selectable>
            ) : (
              <HtmlFrame html={text} width={htmlWidth} />
            )
          }
        />
      )
    case 'csv':
      return (
        <TextView
          url={url}
          t={t}
          lines={SHEET_ROWS}
          render={text => (
            <Table rows={parseCsv(text, extension(path) === 'tsv' ? '\t' : ',', Infinity).rows} />
          )}
        />
      )
    case 'text':
      return (
        <TextView
          url={url}
          t={t}
          render={text => (
            <Selectable lines>
              <CodeBlock code={text} lang={extension(path) || null} streaming={false} />
            </Selectable>
          )}
        />
      )
    case 'binary':
      return <div className="preview-note">{t('noPreview')}</div>
  }
}

function ErrorNote({ error, t }: { error: unknown; t: T }) {
  const status = error instanceof HttpError ? error.status : undefined
  return (
    <div className="preview-note" role="alert">
      {status === 404
        ? t('fileNotFound')
        : status === 501
          ? t('noConverter')
          : t('previewFailed')}
    </div>
  )
}

class Boundary extends Component<
  { children: ReactNode; fallback: (error: unknown) => ReactNode },
  { error?: unknown }
> {
  state: { error?: unknown } = {}
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  render() {
    return this.state.error !== undefined
      ? this.props.fallback(this.state.error)
      : this.props.children
  }
}

/** Right-hand file viewer (#522): toolbar plus a viewer chosen by file type. */
export function Preview({
  sessionId,
  path,
  t,
  onClose,
  files = [],
  onOpen,
  onOpenLocal,
  onComment,
  image,
}: {
  sessionId: string
  /** The file, or with `image` the name shown in the bar. */
  path: string
  t: T
  onClose: () => void
  /** The chat's files (Files tab order), stepped through with ‹ › and ←/→. */
  files?: SessionFile[]
  onOpen?: (path: string) => void
  /** Opens the file (or with `reveal` its folder) on the machine running `claude web`. */
  onOpenLocal?: (reveal: boolean) => void
  /** Sends a comment as a chat message; without it nothing can be commented on. */
  onComment?: (text: string) => void
  /** An image from a chat message, shown in place of a file; `target` names it in comments. */
  image?: { src: string; target: string }
}) {
  const [sent, setSent] = useState<Sent[]>([])
  const [draft, setDraft] = useState<Draft>()
  const [offer, setOffer] = useState<Draft>()
  const subject = image?.src ?? path
  useEffect(() => {
    setSent([])
    setDraft(undefined)
    setOffer(undefined)
  }, [subject])
  // A Comment button outlives its selection only while the selection lasts.
  useEffect(() => {
    if (!offer) return
    const onChange = () => window.getSelection()?.isCollapsed !== false && setOffer(undefined)
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [offer])
  const pinValue = useMemo(
    () =>
      onComment && {
        sent,
        draft,
        place: (next: Draft) => {
          setOffer(undefined)
          setDraft(next)
        },
        offer: (next: Draft | undefined) => !draft && setOffer(next),
        submit: (text: string) => {
          if (!draft) return
          onComment(commentText(image ? image.target : `\`${path}\``, draft.anchor, text))
          setSent(list => [...list, { anchor: draft.anchor, text }])
          setDraft(undefined)
          window.getSelection()?.removeAllRanges()
        },
        cancel: () => setDraft(undefined),
        t,
      },
    [onComment, sent, draft, t, image, path],
  )
  const [htmlWidth, setHtmlWidth] = useState<HtmlView>()
  const isHtml = !image && previewKind(path) === 'html'
  const nav = onOpen && !image ? fileNeighbors(files, path) : undefined
  const prev = nav?.prev
  const next = nav?.next
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const to = e.key === 'ArrowLeft' ? prev : e.key === 'ArrowRight' ? next : undefined
      if (to && onOpen) {
        e.preventDefault()
        onOpen(to)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onOpen, prev, next])
  return (
    <aside className="preview" aria-label={t('preview')}>
      <div className="arthead preview-bar">
        <span className="kind mono">{image ? 'IMG' : (extension(path) || 'TXT').toUpperCase()}</span>
        <span className="nm">
          <b className="mono preview-name" title={path}>
            {baseName(path)}
          </b>
          {!image && <small className="mono">{path.slice(0, path.length - baseName(path).length)}</small>}
        </span>
        {isHtml && (
          <span className="seg" role="radiogroup">
            {WIDTHS.map(w => (
              <button
                type="button"
                role="radio"
                key={w.key}
                aria-checked={htmlWidth === w.width}
                onClick={() => setHtmlWidth(w.width)}
              >
                {t(w.key)}
              </button>
            ))}
          </span>
        )}
        {nav && onOpen && (
          <span className="grp file-nav">
            <button
              type="button"
              aria-label={t('prevFile')}
              title={prev ? `${t('prevFile')}: ${baseName(prev)} (←)` : t('prevFile')}
              disabled={!prev}
              onClick={() => prev && onOpen(prev)}
            >
              ‹
            </button>
            <span className="nav">
              {nav.index + 1}/{nav.total}
            </span>
            <button
              type="button"
              aria-label={t('nextFile')}
              title={next ? `${t('nextFile')}: ${baseName(next)} (→)` : t('nextFile')}
              disabled={!next}
              onClick={() => next && onOpen(next)}
            >
              ›
            </button>
          </span>
        )}
        <span className="grp" style={{ marginLeft: 'auto' }}>
          {!image && (
            <>
              {onOpenLocal && (
                <>
                  <button type="button" className="btn" title={t('openLocalTip')} onClick={() => onOpenLocal(false)}>
                    {t('openLocal')}
                  </button>
                  <button type="button" className="btn" title={t('revealLocalTip')} onClick={() => onOpenLocal(true)}>
                    {t('revealLocal')}
                  </button>
                </>
              )}
              <a className="btn" href={fileUrl(sessionId, path)} target="_blank" rel="noopener">
                {t('openNewTab')}
              </a>
              <a className="btn" href={fileUrl(sessionId, path, { download: true })}>
                {t('download')}
              </a>
            </>
          )}
          <button type="button" className="btn" aria-label={t('close')} onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      <div className="artbody preview-body">
        <Boundary key={subject} fallback={error => <ErrorNote error={error} t={t} />}>
          <PinContext.Provider value={pinValue || undefined}>
            {image ? (
              <Pinnable>
                <img className="preview-image" src={image.src} alt={path} />
              </Pinnable>
            ) : (
              <Body sessionId={sessionId} path={path} t={t} htmlWidth={htmlWidth} />
            )}
          </PinContext.Provider>
        </Boundary>
        {pinValue && offer?.at && (
          <button
            type="button"
            className="btn cpin-offer"
            style={offer.at}
            // Keeps the selection while the button is pressed.
            onMouseDown={e => e.preventDefault()}
            onClick={() => pinValue.place(offer)}
          >
            {t('pinComment')}
          </button>
        )}
        {pinValue && draft?.at && (
          <CommentBox
            key={JSON.stringify(draft.anchor)}
            style={draft.at}
            t={t}
            onSubmit={pinValue.submit}
            onCancel={pinValue.cancel}
          />
        )}
      </div>
    </aside>
  )
}
