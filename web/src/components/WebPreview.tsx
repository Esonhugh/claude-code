import { useEffect, useState } from 'react'
import type { MessageKey } from '../i18n'

/**
 * A local dev server or `--preview-origin` page in the artifact view. The URL
 * has passed `previewTarget`, so its origin is never this UI's; that is what
 * makes allow-same-origin safe here.
 */
export function WebPreview({
  url,
  t,
  onClose,
}: {
  url: string
  t: (key: MessageKey) => string
  onClose: () => void
}) {
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <aside className="preview" aria-label={t('preview')}>
      <div className="arthead preview-bar">
        <span className="kind mono">URL</span>
        <span className="nm">
          <b className="mono preview-name" title={url}>
            {url}
          </b>
        </span>
        <span className="grp" style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn" onClick={() => setReloads(n => n + 1)}>
            {t('reload')}
          </button>
          <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
            {t('openNewTab')}
          </a>
          <button type="button" className="btn" aria-label={t('close')} onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      <iframe
        key={`${url}#${reloads}`}
        className="web-preview-frame"
        title={url}
        src={url}
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        referrerPolicy="no-referrer"
      />
    </aside>
  )
}
