import type {
  Definition,
  ListItem,
  Nodes,
  Parents,
  Root,
  RootContent,
  Table,
} from 'mdast'
// The default import keeps `bun test` (classic JSX from the root tsconfig) working.
import React, {
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'
import { LANGS, type Lang, translate } from '../i18n'
import { WebPreviewContext } from '../webPreview'
import { cachedHighlight, highlight } from './highlight'
import { parseMarkdown, splitSettled } from './parse'
import { localFileSrc, safeImageSrc, safeLinkHref } from './safeUrl'

type WebPreview = React.ContextType<typeof WebPreviewContext>

type Ctx = {
  definitions: Map<string, Definition>
  streaming: boolean
  filesBase?: string
  preview?: WebPreview
}

/** `node` followed by a "Preview" button when `url` can be framed. */
/** Inline code with a run this long and no break opportunity (a hash, a long file name). */
const LONG_TOKEN = /[^\s/-]{32}/

function withPreview(node: ReactNode, url: string, ctx: Ctx, key: number): ReactNode {
  const { target, open, label } = ctx.preview ?? {}
  const href = target?.(url)
  if (!href || !open) return node
  return (
    <React.Fragment key={key}>
      {node}
      <button
        type="button"
        className="chipbtn link-preview"
        title={href}
        onClick={() => open(href)}
      >
        {label}
      </button>
    </React.Fragment>
  )
}

function collectDefinitions(root: Root, into = new Map<string, Definition>()) {
  const walk = (node: Nodes) => {
    if (node.type === 'definition') into.set(node.identifier, node)
    if ('children' in node) for (const child of node.children) walk(child)
  }
  walk(root)
  return into
}

function plainText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node) return node.children.map(plainText).join('')
  return ''
}

export function CodeBlock({
  code,
  lang,
  streaming,
}: {
  code: string
  lang: string | null | undefined
  streaming: boolean
}) {
  const [html, setHtml] = useState(() => (streaming ? undefined : cachedHighlight(code, lang)))
  const [copied, setCopied] = useState(false)
  // React re-applies a new `__html` object on every render, which replaces the nodes and drops
  // any selection in them (the preview's Comment button rerenders this on mouseup).
  const inner = useMemo(() => (html ? { __html: html } : undefined), [html])
  useEffect(() => {
    if (streaming) return
    const hit = cachedHighlight(code, lang)
    if (hit !== undefined) {
      setHtml(hit)
      return
    }
    let live = true
    highlight(code, lang).then(
      out => live && setHtml(out),
      () => live && setHtml(undefined),
    )
    return () => {
      live = false
    }
  }, [code, lang, streaming])

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // Markdown is rendered without the app's `t`; the page language is on <html>.
  const pageLang = typeof document === 'undefined' ? '' : document.documentElement.lang
  const copyLabel = translate(
    LANGS.some(l => l.id === pageLang) ? (pageLang as Lang) : 'en',
    copied ? 'copied' : 'copy',
  )

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang ?? ''}</span>
        <button type="button" className="ghost" aria-label={copyLabel} onClick={copy}>
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      {inner ? (
        <div
          className="codeblock-body"
          // shiki escapes the code; the markup is its own spans.
          dangerouslySetInnerHTML={inner}
        />
      ) : (
        <pre className="codeblock-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

let mermaidReady: Promise<typeof import('mermaid').default> | undefined

function Mermaid({ code, streaming }: { code: string; streaming: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (streaming) return
    let live = true
    mermaidReady ??= import('mermaid').then(mod => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'default',
      })
      return mod.default
    })
    mermaidReady
      .then(mermaid => mermaid.render(`mermaid-${id}`, code))
      .then(
        result => live && setSvg(result.svg),
        () => live && setFailed(true),
      )
    return () => {
      live = false
    }
  }, [code, id, streaming])
  if (svg && !failed) {
    // Rendered with securityLevel 'strict', which sanitizes labels.
    return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  }
  return <CodeBlock code={code} lang="mermaid" streaming />
}

let katexReady: Promise<typeof import('katex').default> | undefined

function MathNode({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string>()
  useEffect(() => {
    let live = true
    katexReady ??= Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([mod]) => mod.default)
    katexReady.then(katex => {
      if (!live) return
      setHtml(
        katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          trust: false,
          strict: 'ignore',
        }),
      )
    })
    return () => {
      live = false
    }
  }, [tex, display])
  const Tag = display ? 'div' : 'span'
  if (!html) return <Tag className="math-src">{tex}</Tag>
  // KaTeX output with trust: false (no \href, \url or raw HTML commands).
  return <Tag className={display ? 'math-block' : undefined} dangerouslySetInnerHTML={{ __html: html }} />
}

function renderChildren(node: Parents, ctx: Ctx): ReactNode[] {
  return node.children.map((child, i) => renderNode(child as RootContent, ctx, i))
}

function renderTable(node: Table, ctx: Ctx, key: number): ReactNode {
  const [head, ...body] = node.children
  const align = (i: number) => node.align?.[i] ?? undefined
  return (
    <div className="table-wrap" key={key}>
      <table>
        {head && (
          <thead>
            <tr>
              {head.children.map((cell, i) => (
                <th key={i} style={{ textAlign: align(i) }}>
                  {renderChildren(cell, ctx)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.children.map((cell, i) => (
                <td key={i} style={{ textAlign: align(i) }}>
                  {renderChildren(cell, ctx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function renderListItem(node: ListItem, ctx: Ctx, key: number): ReactNode {
  // Tight list items wrap their text in a paragraph; unwrap it.
  const children = node.spread
    ? renderChildren(node, ctx)
    : node.children.flatMap((child, i) =>
        child.type === 'paragraph'
          ? renderChildren(child, ctx)
          : [renderNode(child, ctx, i)],
      )
  return (
    <li key={key} className={node.checked == null ? undefined : 'task'}>
      {node.checked != null && (
        <input type="checkbox" checked={node.checked} readOnly disabled />
      )}
      {children}
    </li>
  )
}

function renderLink(
  href: string | undefined,
  title: string | null | undefined,
  children: ReactNode[],
  key: number,
  ctx: Ctx,
): ReactNode {
  if (!href) return <span key={key}>{children}</span>
  return withPreview(
    <a
      key={key}
      href={href}
      title={title ?? undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      {children}
    </a>,
    href,
    ctx,
    key,
  )
}

function renderImage(
  url: string,
  alt: string | null | undefined,
  key: number,
  ctx: Ctx,
): ReactNode {
  const src = safeImageSrc(localFileSrc(url, ctx.filesBase))
  if (!src) return <span key={key}>{alt || url}</span>
  return <img key={key} src={src} alt={alt ?? ''} loading="lazy" />
}

function renderNode(node: RootContent, ctx: Ctx, key: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{renderChildren(node, ctx)}</p>
    case 'heading': {
      const Tag = `h${Math.min(node.depth + 1, 6)}` as 'h2'
      return <Tag key={key}>{renderChildren(node, ctx)}</Tag>
    }
    case 'thematicBreak':
      return <hr key={key} />
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node, ctx)}</blockquote>
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul'
      return (
        <Tag key={key} start={node.ordered && node.start !== 1 ? (node.start ?? undefined) : undefined}>
          {node.children.map((item, i) => renderListItem(item, ctx, i))}
        </Tag>
      )
    }
    case 'listItem':
      return renderListItem(node, ctx, key)
    case 'table':
      return renderTable(node, ctx, key)
    case 'code':
      return node.lang === 'mermaid' ? (
        <Mermaid key={key} code={node.value} streaming={ctx.streaming} />
      ) : (
        <CodeBlock key={key} code={node.value} lang={node.lang} streaming={ctx.streaming} />
      )
    case 'math':
      return <MathNode key={key} tex={node.value} display />
    case 'inlineMath':
      return <MathNode key={key} tex={node.value} display={false} />
    case 'html':
      // Raw HTML in model output is shown as text, never parsed.
      return <span key={key}>{node.value}</span>
    case 'text':
      return node.value
    case 'emphasis':
      return <em key={key}>{renderChildren(node, ctx)}</em>
    case 'strong':
      return <strong key={key}>{renderChildren(node, ctx)}</strong>
    case 'delete':
      return <del key={key}>{renderChildren(node, ctx)}</del>
    case 'inlineCode':
      return withPreview(
        <code key={key} className={LONG_TOKEN.test(node.value) ? 'long' : undefined}>
          {node.value}
        </code>,
        node.value.trim(),
        ctx,
        key,
      )
    case 'break':
      return <br key={key} />
    case 'link':
      return renderLink(safeLinkHref(node.url), node.title, renderChildren(node, ctx), key, ctx)
    case 'linkReference': {
      const def = ctx.definitions.get(node.identifier)
      return renderLink(
        def ? safeLinkHref(def.url) : undefined,
        def?.title,
        renderChildren(node, ctx),
        key,
        ctx,
      )
    }
    case 'image':
      return renderImage(node.url, node.alt, key, ctx)
    case 'imageReference': {
      const def = ctx.definitions.get(node.identifier)
      return def ? renderImage(def.url, node.alt, key, ctx) : <span key={key}>{node.alt}</span>
    }
    case 'footnoteReference':
      return <sup key={key}>[{node.label ?? node.identifier}]</sup>
    case 'footnoteDefinition':
      return (
        <div key={key} className="footnote">
          <sup>[{node.label ?? node.identifier}]</sup> {renderChildren(node, ctx)}
        </div>
      )
    case 'definition':
      return null
    default:
      return 'children' in node ? (
        <span key={key}>{renderChildren(node as Parents, ctx)}</span>
      ) : 'value' in node ? (
        plainText(node)
      ) : null
  }
}

// Opening a session again draws the same replies; their parse trees are kept (oldest dropped first).
const PARSED_SIZE = 300
const parsed = new Map<string, Root>()

function parseSettled(text: string, keep: boolean): Root {
  const hit = parsed.get(text)
  if (hit) return hit
  const root = parseMarkdown(text)
  // A streaming reply's settled prefix grows paragraph by paragraph; only finished text is worth keeping.
  if (!keep) return root
  if (parsed.size >= PARSED_SIZE) parsed.delete(parsed.keys().next().value!)
  parsed.set(text, root)
  return root
}

const Settled = memo(function Settled({
  text,
  keep,
  filesBase,
  preview,
}: {
  text: string
  keep: boolean
  filesBase?: string
  preview: WebPreview
}) {
  const root = useMemo(() => parseSettled(text, keep), [text, keep])
  const ctx = useMemo(
    () => ({ definitions: collectDefinitions(root), streaming: false, filesBase, preview }),
    [root, filesBase, preview],
  )
  return <>{root.children.map((node, i) => renderNode(node, ctx, i))}</>
})

/**
 * Renders model Markdown. While streaming, the settled prefix is parsed once
 * and memoized; only the tail is re-parsed on each delta.
 */
export function Markdown({
  text,
  streaming = false,
  filesBase,
}: {
  text: string
  streaming?: boolean
  /** `/api/files/<session>`: local image paths load through it. */
  filesBase?: string
}) {
  const preview = useContext(WebPreviewContext)
  const { settled, tail } = useMemo(
    () => (streaming ? splitSettled(text) : { settled: text, tail: '' }),
    [text, streaming],
  )
  const tailRoot = useMemo(() => (tail ? parseMarkdown(tail) : undefined), [tail])
  const tailCtx = useMemo(
    () =>
      tailRoot
        ? { definitions: collectDefinitions(tailRoot), streaming: true, filesBase, preview }
        : undefined,
    [tailRoot, filesBase, preview],
  )
  return (
    <div className="markdown">
      {settled && <Settled text={settled} keep={!streaming} filesBase={filesBase} preview={preview} />}
      {tailRoot && tailCtx && tailRoot.children.map((node, i) => renderNode(node, tailCtx, i))}
    </div>
  )
}
