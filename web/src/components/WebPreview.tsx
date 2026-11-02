import { useEffect, useState } from 'react'
import type { MessageKey } from '../i18n'

/**
 * A local dev server or `--preview-origin` page in the preview slot. The URL
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
      <div className="preview-bar">
        <span className="preview-name" title={url}>
          {url}
        </span>
        <button type="button" className="ghost" onClick={() => setReloads(n => n + 1)}>
          {t('reload')}
        </button>
        <a className="ghost" href={url} target="_blank" rel="noopener noreferrer">
          {t('openNewTab')}
        </a>
        <button type="button" className="ghost" aria-label={t('close')} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="web-preview-hint">{t('webPreviewHint')}</div>
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
