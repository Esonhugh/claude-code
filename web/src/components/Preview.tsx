import {
  Component,
  type ReactNode,
  useEffect,
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

/** The first megabyte as text; `truncated` when the file is longer. */
async function fetchText(url: string): Promise<{ text: string; truncated: boolean }> {
  const res = await fetchOk(url, { headers: { Range: `bytes=0-${TEXT_BYTES - 1}` } })
  const total = Number(res.headers.get('content-range')?.split('/')[1] ?? 0)
  const text = await res.text()
  const lines = text.split('\n')
  return lines.length > TEXT_LINES
    ? { text: lines.slice(0, TEXT_LINES).join('\n'), truncated: true }
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
  return value ? <img className="preview-image" src={value} alt={name} /> : null
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

/** One page, drawn when it comes near the view; until then a blank of the first page's shape. */
function PdfPage({ doc, n, width, aspect }: { doc: PdfDoc; n: number; width: number; aspect: number }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
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
    let live = true
    void doc.getPage(n).then(p => {
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
    })
    return () => {
      live = false
      task?.cancel()
    }
  }, [doc, n, width, near])

  return (
    <div className="pdf-page" ref={box} data-page={n} style={drawn ? undefined : { width, height: width * aspect }}>
      <canvas ref={canvas} hidden={!drawn} />
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
    <div className="pdf" ref={root}>
      <div className="pager">
        <button type="button" className="ghost" aria-label={t('prevPage')} disabled={page <= 1} onClick={() => go(page - 1)}>
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

function Table({ rows, note }: { rows: string[][]; note?: string }) {
  return (
    <div className="sheet">
      <table>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>,
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div className="preview-note">{note}</div>}
    </div>
  )
}

function XlsxView({ url, t }: { url: string; t: T }) {
  const [sheet, setSheet] = useState(0)
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
      if (rows.length >= SHEET_ROWS) return
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      rows.push(values.map(v => cellText(v as Cell)))
    })
    return { rows, total: ws.rowCount }
  }, [book, sheet])
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
            onClick={() => setSheet(i)}
          >
            {ws.name}
          </button>
        ))}
      </div>
      <Table
        rows={table.rows}
        note={
          table.total > table.rows.length
            ? t('rowsShown', { shown: String(table.rows.length), total: String(table.total) })
            : undefined
        }
      />
    </>
  )
}

function DocxView({ url, t }: { url: string; t: T }) {
  const { value, error } = useLoad(async () => {
    const [res, mammoth, p] = await Promise.all([fetchOk(url), import('mammoth'), purify()])
    const out = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() })
    return p.sanitize(out.value)
  }, [url])
  if (error) throw error
  if (value === undefined) return <div className="preview-note">{t('loading')}</div>
  return (
    <div
      className="docx-page"
      // DOMPurify-sanitized output of mammoth.
      dangerouslySetInnerHTML={{ __html: value }}
    />
  )
}

function TextView({
  url,
  render,
  t,
}: {
  url: string
  render: (text: string) => ReactNode
  t: T
}) {
  const { value, error } = useLoad(() => fetchText(url), [url])
  if (error) throw error
  if (!value) return <div className="preview-note">{t('loading')}</div>
  return (
    <>
      {render(value.text)}
      {value.truncated && <div className="preview-note">{t('previewTruncated')}</div>}
    </>
  )
}

const WIDTHS = [
  { key: 'widthDesktop', width: undefined },
  { key: 'widthTablet', width: 768 },
  { key: 'widthPhone', width: 390 },
] as const

function Body({
  sessionId,
  path,
  t,
  htmlWidth,
}: {
  sessionId: string
  path: string
  t: T
  htmlWidth?: number
}) {
  const url = fileUrl(sessionId, path)
  const name = baseName(path)
  switch (previewKind(path)) {
    case 'image':
      return <img className="preview-image" src={url} alt={name} />
    case 'svg':
      return <SvgImage url={url} name={name} />
    case 'pdf':
      return <PdfView url={url} t={t} />
    case 'office':
      return <PdfView url={fileUrl(sessionId, path, { pdf: true })} t={t} />
    case 'xlsx':
      return <XlsxView url={url} t={t} />
    case 'docx':
      return <DocxView url={url} t={t} />
    case 'markdown':
      return (
        <TextView
          url={url}
          t={t}
          render={text => <Markdown text={text} filesBase={filesBase(sessionId)} />}
        />
      )
    case 'html':
      return (
        <TextView
          url={url}
          t={t}
          render={text => <HtmlFrame html={text} width={htmlWidth} />}
        />
      )
    case 'csv':
      return (
        <TextView
          url={url}
          t={t}
          render={text => {
            const { rows, truncated } = parseCsv(
              text,
              extension(path) === 'tsv' ? '\t' : ',',
              SHEET_ROWS,
            )
            return <Table rows={rows} note={truncated ? t('previewTruncated') : undefined} />
          }}
        />
      )
    case 'text':
      return (
        <TextView
          url={url}
          t={t}
          render={text => (
            <CodeBlock code={text} lang={extension(path) || null} streaming={false} />
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
}: {
  sessionId: string
  path: string
  t: T
  onClose: () => void
  /** The chat's files (Files tab order), stepped through with ‹ › and ←/→. */
  files?: SessionFile[]
  onOpen?: (path: string) => void
}) {
  const [htmlWidth, setHtmlWidth] = useState<number>()
  const isHtml = previewKind(path) === 'html'
  const nav = onOpen ? fileNeighbors(files, path) : undefined
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
        <span className="kind mono">{(extension(path) || 'TXT').toUpperCase()}</span>
        <span className="nm">
          <b className="mono preview-name" title={path}>
            {baseName(path)}
          </b>
          <small className="mono">{path.slice(0, path.length - baseName(path).length)}</small>
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
          <a className="btn" href={fileUrl(sessionId, path)} target="_blank" rel="noopener">
            {t('openNewTab')}
          </a>
          <a className="btn" href={fileUrl(sessionId, path, { download: true })}>
            {t('download')}
          </a>
          <button type="button" className="btn" aria-label={t('close')} onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      <div className="artbody preview-body">
        <Boundary key={path} fallback={error => <ErrorNote error={error} t={t} />}>
          <Body sessionId={sessionId} path={path} t={t} htmlWidth={htmlWidth} />
        </Boundary>
      </div>
    </aside>
  )
}
