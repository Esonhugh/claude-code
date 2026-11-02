import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  type Account,
  type AuthProvider,
  cancelOAuth,
  getAccount,
  logout,
  saveApiKey,
  startOAuth,
  submitOAuthCode,
} from '../api'
import { Dialog } from './Dialog'
import type { T } from './ui'

const DEFAULT_BASE: Record<AuthProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
}
const PROVIDER_NAME: Record<AuthProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

export const keyName = (provider: AuthProvider) => `${PROVIDER_NAME[provider]} API key`

/** Same rule as the server: empty, or http(s) without credentials, query or fragment. */
export function isValidBaseUrl(value: string): boolean {
  if (value === '') return true
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

/** `api.anthropic.com`, or the custom base URL without its scheme. */
export function baseHost(provider: AuthProvider, baseUrl: string): string {
  return (baseUrl || DEFAULT_BASE[provider]).replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

const keyOf = (account: Account, provider: AuthProvider) => account.keys.find(k => k.provider === provider)

function KeyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.7 8.3 13.5 2.5M11 5l2 2M12.5 3.5l1.5 1.5" />
    </svg>
  )
}

/** The account the page shows, kept fresh while an OAuth login is pending. */
export function useAccount(t: T) {
  const [account, setAccount] = useState<Account>()
  const [flash, setFlash] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const show = useCallback((text: string) => {
    setFlash(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlash(undefined), 2500)
  }, [])
  const refresh = useCallback(() => getAccount().then(setAccount, () => {}), [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const pending = account?.pending?.provider
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => {
      getAccount().then(next => {
        setAccount(next)
        if (next.pending) return
        if (next.error) show(next.error)
        else if (next.kind) show(t(pending === 'openai' ? 'signedInChatgpt' : 'signedInClaude'))
      }, () => {})
    }, 1500)
    return () => clearInterval(id)
  }, [pending, show, t])

  const run = async (action: () => Promise<unknown>, done?: string) => {
    try {
      await action()
      if (done) show(done)
    } catch (err) {
      show(err instanceof Error ? err.message : String(err))
    }
    await refresh()
  }
  return {
    account,
    flash,
    /** Opens the tab synchronously (popup blockers), then points it at the login page. */
    login: (provider: AuthProvider) => {
      const tab = window.open('', '_blank')
      void run(async () => {
        try {
          const { url } = await startOAuth(provider)
          if (tab) {
            tab.opener = null
            tab.location.href = url
          }
        } catch (err) {
          tab?.close()
          throw err
        }
      }, t('loginOpened'))
    },
    submitCode: (code: string) => run(() => submitOAuthCode(code)),
    cancel: () => run(() => cancelOAuth()),
    logout: () => run(() => logout(), t('signedOutFlash')),
    saveKey: async (provider: AuthProvider, key: string, baseUrl: string) => {
      setAccount(await saveApiKey(provider, key, baseUrl))
      show(t('switchedTo', { name: keyName(provider) }))
    },
    copied: () => show(t('linkCopied')),
  }
}

export type AccountApi = ReturnType<typeof useAccount>

/** The card itself: avatar, name and plan only; the details live in the menu. */
function cardText(t: T, account: Account | undefined): { avatar: ReactNode; name: string; plan?: string } {
  if (!account?.kind) return { avatar: '?', name: t('acctSignedOut') }
  if (account.kind === 'apikey') return { avatar: <KeyIcon />, name: t('apiUser') }
  const name = account.name ?? (account.kind === 'chatgpt' ? 'ChatGPT' : 'Claude')
  return { avatar: name[0]!.toUpperCase(), name, plan: account.plan }
}

function authStatus(t: T, account: Account): string {
  if (account.kind === 'claude') return [t('authClaude'), account.plan].filter(Boolean).join(' · ')
  if (account.kind === 'chatgpt') return [t('authChatgpt'), account.plan].filter(Boolean).join(' · ')
  const key = keyOf(account, account.provider)
  return [keyName(account.provider), key?.masked ?? account.source].filter(Boolean).join(' · ')
}

/** Sidebar account card and its menu: header, Auth submenu, sign out. */
export function AccountCard({
  t,
  api,
  onKeyDialog,
  onDialog,
}: {
  t: T
  api: AccountApi
  onKeyDialog: (p: AuthProvider) => void
  /** Settings, Stats and Shortcuts live in this menu, below the Auth submenu. */
  onDialog: (kind: 'settings' | 'stats' | 'keys') => void
}) {
  const { account } = api
  const [menu, setMenu] = useState<'main' | 'auth'>()
  const wrap = useRef<HTMLDivElement>(null)
  const host = location.hostname
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(undefined)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMenu(undefined)
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])
  const card = cardText(t, account)
  const pick = (action: () => void) => () => {
    setMenu(undefined)
    action()
  }
  const keyButtons = (label: 'useKeyInstead' | 'useKey') =>
    (['anthropic', 'openai'] as const).map(p => (
      <button type="button" className="btn" role="menuitem" key={p} onClick={pick(() => onKeyDialog(p))}>
        {t(label, { name: keyName(p) })}
      </button>
    ))
  const pages = (
    <>
      <button type="button" className="btn" role="menuitem" onClick={pick(() => onDialog('settings'))}>
        <span className="ico">⚙</span>
        {t('settings')}
      </button>
      <button type="button" className="btn" role="menuitem" onClick={pick(() => onDialog('stats'))}>
        <span className="ico">▤</span>Stats
      </button>
      <button type="button" className="btn" role="menuitem" onClick={pick(() => onDialog('keys'))}>
        <span className="ico">?</span>
        {t('shortcuts')}
      </button>
    </>
  )
  let items
  if (!account?.kind) {
    items = (
      <>
        <button type="button" className="btn" role="menuitem" onClick={pick(() => api.login('anthropic'))}>
          {t('signInClaude')}
        </button>
        <button type="button" className="btn" role="menuitem" onClick={pick(() => api.login('openai'))}>
          {t('signInChatgpt')}
        </button>
        {keyButtons('useKey')}
        <div className="sep" role="separator" />
        {pages}
      </>
    )
  } else if (menu === 'auth') {
    items = (
      <>
        <div className="ah">
          <button type="button" className="ah-back" aria-label={t('back')} onClick={() => setMenu('main')}>
            ‹
          </button>
          <b>{t('authMenu')}</b>
          <small>{t('authCurrent', { status: authStatus(t, account) })}</small>
        </div>
        {account.kind !== 'claude' && (
          <button type="button" className="btn" role="menuitem" onClick={pick(() => api.login('anthropic'))}>
            {t('switchClaude')}
          </button>
        )}
        {account.kind !== 'chatgpt' && (
          <button type="button" className="btn" role="menuitem" onClick={pick(() => api.login('openai'))}>
            {t('switchChatgpt')}
          </button>
        )}
        {keyButtons('useKeyInstead')}
      </>
    )
  } else {
    const key = keyOf(account, account.provider)
    items = (
      <>
        <div className="ah acct-h">
          <span className="avatar">{card.avatar}</span>
          <div>
            <b>{card.name}</b>
            {account.kind === 'apikey' ? (
              <small>
                {keyName(account.provider)} · <span className="mono">{baseHost(account.provider, key?.base_url ?? '')}</span>{' '}
                · {t('payAsYouGo')}
              </small>
            ) : (
              card.plan && <small>{account.kind === 'chatgpt' ? `${card.plan} · OpenAI` : card.plan}</small>
            )}
            <small>{t('localHost', { host })}</small>
          </div>
        </div>
        <button type="button" className="btn sub" role="menuitem" aria-haspopup="menu" onClick={() => setMenu('auth')}>
          <span>
            {t('authMenu')}
            <small>{authStatus(t, account)}</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
        {pages}
        <button type="button" className="btn" role="menuitem" onClick={pick(() => void api.logout())}>
          {t('signOut')}
        </button>
      </>
    )
  }
  return (
    <div className="acctwrap" ref={wrap}>
      <button
        type="button"
        className="acct"
        id="acct-btn"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={() => setMenu(menu ? undefined : 'main')}
      >
        <span className={`avatar${account?.kind ? '' : ' none'}`}>{card.avatar}</span>
        <div>
          {card.name}
          {card.plan && <small>{card.plan}</small>}
        </div>
      </button>
      {menu && (
        <div className="pop acctmenu" id="acct-menu" role="menu">
          {items}
        </div>
      )}
      {api.flash && (
        <div className="flash" role="status">
          {api.flash}
        </div>
      )}
    </div>
  )
}

/** Key and base URL for one provider; the stored key only ever shows masked. */
export function ApiKeyDialog({
  t,
  api,
  provider,
  onClose,
}: {
  t: T
  api: AccountApi
  provider: AuthProvider
  onClose: () => void
}) {
  const stored = api.account && keyOf(api.account, provider)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(stored?.base_url ?? '')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const base = baseUrl.trim()
  const badBase = !isValidBaseUrl(base)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (badBase) return
    if (!key.trim() && !stored?.masked) {
      setError(t('apiKeyRequired'))
      return
    }
    setBusy(true)
    try {
      await api.saveKey(provider, key.trim(), base)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <Dialog t={t} title={keyName(provider)} onClose={onClose}>
      <form className="hookform keyform" onSubmit={e => void submit(e)}>
        <label htmlFor="key-input">API key</label>
        <input
          id="key-input"
          className="mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={key}
          placeholder={stored?.masked ? t('apiKeyKeep', { masked: stored.masked }) : provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
          onChange={e => {
            setKey(e.target.value)
            setError(undefined)
          }}
        />
        <label htmlFor="base-input">Base URL</label>
        <input
          id="base-input"
          className="mono"
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          placeholder={DEFAULT_BASE[provider]}
          aria-invalid={badBase}
          onChange={e => setBaseUrl(e.target.value)}
        />
        <span />
        <small className="note">
          {badBase ? t('baseUrlInvalid') : t('baseUrlHint', { name: provider === 'anthropic' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL' })}
        </small>
        {error && (
          <div className="notice" role="alert" style={{ gridColumn: '1 / -1' }}>
            {error}
          </div>
        )}
        <div className="btns">
          <span className="note">{t('credentialsLocal')}</span>
          <button className="btn" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn primary" type="submit" disabled={busy || badBase}>
            {t('save')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** The composer's sign-in gate: options when signed out, the manual-code fallback while a login is pending. */
export function LoginGate({ t, api, onKeyDialog }: { t: T; api: AccountApi; onKeyDialog: (p: AuthProvider) => void }) {
  const { account } = api
  const [code, setCode] = useState('')
  if (!account || (account.kind && !account.pending)) return null
  const pending = account.pending
  if (pending) {
    const chatgpt = pending.provider === 'openai'
    return (
      <div className="gate" id="gate">
        <b>{t('gateWaiting', { who: chatgpt ? 'ChatGPT' : 'Claude' })}</b>
        <span className="note">{t('gateManual', { extra: chatgpt ? t('gateManualUrl') : '' })}</span>
        <div className="gmanual">
          <a className="glink mono" href={pending.manual_url} target="_blank" rel="noopener noreferrer">
            {pending.manual_url}
          </a>
          <button
            className="btn"
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(pending.manual_url).then(api.copied, () => {})
            }}
          >
            {t('copyLink')}
          </button>
        </div>
        <form
          className="gmanual"
          id="login-manual"
          onSubmit={e => {
            e.preventDefault()
            void api.submitCode(code.trim())
            setCode('')
          }}
        >
          <input
            id="login-code"
            value={code}
            placeholder={chatgpt ? 'http://localhost:1455/auth/callback?code=…' : t('codePh')}
            autoComplete="off"
            required
            onChange={e => setCode(e.target.value)}
          />
          <button className="btn primary" type="submit">
            {t('finishSignIn')}
          </button>
          <button className="btn" type="button" onClick={() => void api.cancel()}>
            {t('cancel')}
          </button>
        </form>
      </div>
    )
  }
  return (
    <div className="gate" id="gate">
      <b>{t('gateTitle')}</b>
      <span className="note">{t('gateNote')}</span>
      <div className="gopts">
        <button className="btn primary" type="button" onClick={() => api.login('anthropic')}>
          {t('signInClaude')}
        </button>
        <button className="btn" type="button" onClick={() => api.login('openai')}>
          {t('signInChatgpt')}
        </button>
        {(['anthropic', 'openai'] as const).map(p => (
          <button className="btn" type="button" key={p} onClick={() => onKeyDialog(p)}>
            {t('useKey', { name: keyName(p) })}
          </button>
        ))}
      </div>
    </div>
  )
}
