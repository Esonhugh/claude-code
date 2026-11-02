import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  type Account,
  type AuthProvider,
  cancelOAuth,
  getAccount,
  logout,
  removeApiKey,
  saveApiKey,
  startOAuth,
  submitOAuthCode,
  useSavedKey,
} from '../api'
import { Dialog } from './Dialog'
import type { T } from './ui'

const DEFAULT_BASE: Record<AuthProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
}
const PROVIDERS = ['anthropic', 'openai'] as const
const PROVIDER_NAME: Record<AuthProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
// Wide screens open the Auth submenu as a flyout on hover; narrow ones inline.
const WIDE = '(min-width: 761px)'

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

const keyOf = (account: Account | undefined, provider: AuthProvider) => account?.keys.find(k => k.provider === provider)

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
    /** A saved key is switched to directly; otherwise the dialog asks for one. */
    useKey: (provider: AuthProvider, openDialog: (p: AuthProvider) => void) => {
      if (!keyOf(account, provider)?.source) return openDialog(provider)
      void run(() => useSavedKey(provider), t('switchedTo', { name: keyName(provider) }))
    },
    submitCode: (code: string) => run(() => submitOAuthCode(code)),
    cancel: () => run(() => cancelOAuth()),
    logout: () => run(() => logout(), t('signedOutFlash')),
    saveKey: async (provider: AuthProvider, key: string, baseUrl: string) => {
      setAccount(await saveApiKey(provider, key, baseUrl))
      show(t('savedAndUsing', { name: keyName(provider) }))
    },
    removeKey: async (provider: AuthProvider) => {
      setAccount(await removeApiKey(provider))
      show(t('keyRemoved', { name: keyName(provider) }))
    },
    copied: () => show(t('linkCopied')),
  }
}

export type AccountApi = ReturnType<typeof useAccount>

/** Avatar letter, name and the line under it (plan, key type, or a sign-in hint). */
function who(t: T, account: Account | undefined) {
  if (!account?.kind) return { avatar: '?', name: t('acctSignedOut'), sub: t('chooseSignIn') }
  if (account.kind === 'apikey') {
    return { avatar: 'A', name: 'API User', sub: `${keyName(account.provider)} · ${t('payAsYouGo')}` }
  }
  const name = account.name ?? (account.kind === 'chatgpt' ? 'ChatGPT' : 'Claude')
  return { avatar: name[0]!.toUpperCase(), name, plan: account.plan, sub: account.plan ?? '' }
}

/** Sidebar account card; its menu holds the Auth submenu, Settings, Stats, Shortcuts and sign out. */
export function AccountCard({
  t,
  api,
  onKeyDialog,
  onDialog,
}: {
  t: T
  api: AccountApi
  onKeyDialog: (p: AuthProvider) => void
  onDialog: (kind: 'settings' | 'stats' | 'keys') => void
}) {
  const { account } = api
  const [open, setOpen] = useState(false)
  const [auth, setAuth] = useState(false)
  const [place, setPlace] = useState<CSSProperties>()
  const wrap = useRef<HTMLDivElement>(null)
  const authBtn = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const close = useCallback(() => {
    setOpen(false)
    setAuth(false)
  }, [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (wrap.current?.contains(document.activeElement)) document.getElementById('acct-btn')?.focus()
        close()
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])
  // The sidebar clips overflow, so the flyout is fixed next to the Auth row.
  const showAuth = (on: boolean) => {
    clearTimeout(closeTimer.current)
    setAuth(on)
    const r = authBtn.current?.getBoundingClientRect()
    if (on && r && window.matchMedia(WIDE).matches) {
      setPlace({ left: r.right + 4, bottom: Math.max(8, window.innerHeight - r.bottom - 6) })
    } else setPlace(undefined)
  }
  const pick = (action: () => void) => () => {
    // The item goes away with the menu; a dialog it opens returns focus to the account button.
    document.getElementById('acct-btn')?.focus()
    close()
    action()
  }
  const me = who(t, account)
  const rows = [
    { id: 'anthropic-oauth', label: 'Anthropic OAuth', sub: t('authClaude'), on: account?.kind === 'claude', go: () => api.login('anthropic') },
    { id: 'openai-oauth', label: 'OpenAI OAuth', sub: t('authChatgpt'), on: account?.kind === 'chatgpt', go: () => api.login('openai') },
    ...PROVIDERS.map(p => {
      const key = keyOf(account, p)
      return {
        id: p,
        label: keyName(p),
        sub: key?.source
          ? `${t('keySaved', { tail: key.tail ?? '' })} · ${baseHost(p, key.base_url)}`
          : t('keyNotSet'),
        on: account?.kind === 'apikey' && account.provider === p,
        go: () => api.useKey(p, onKeyDialog),
        edit: () => onKeyDialog(p),
      }
    }),
  ]
  return (
    <div className="acctwrap" ref={wrap}>
      <button
        type="button"
        className="acct"
        id="acct-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={`avatar${account?.kind ? '' : ' none'}`}>{me.avatar}</span>
        <div>
          <b>{me.name}</b>
          {me.plan && <small>{me.plan}</small>}
        </div>
      </button>
      {open && (
        <div
          className="pop acctmenu"
          id="acct-menu"
          role="menu"
          onMouseLeave={() => {
            if (auth && window.matchMedia(WIDE).matches) closeTimer.current = setTimeout(() => setAuth(false), 400)
          }}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
        >
          <div className="ah">
            <span className={`avatar${account?.kind ? '' : ' none'}`}>{me.avatar}</span>
            <div>
              <b>{me.name}</b>
              <small>{me.sub}</small>
            </div>
          </div>
          <div
            className="authwrap"
            onMouseEnter={() => {
              if (!auth && window.matchMedia(WIDE).matches) showAuth(true)
            }}
          >
            <button
              type="button"
              className="mi"
              ref={authBtn}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={auth}
              // Hover already opened it on wide screens; a click there must not close it again.
              onClick={() => showAuth(window.matchMedia(WIDE).matches || !auth)}
            >
              <span className="ico">⚿</span>
              {t('authMenu')}
              <span className="chev">›</span>
            </button>
            {auth && (
              <div className="pop authmenu" id="auth-menu" role="menu" style={place}>
                <div className="mh">{t('switchAuth')}</div>
                {rows.map(row => (
                  <div className="authrow" key={row.id}>
                    <button
                      type="button"
                      className="mi"
                      role="menuitemradio"
                      aria-checked={row.on}
                      onClick={pick(row.on && !('edit' in row) ? () => {} : row.go)}
                    >
                      <span className="ck">{row.on ? '✓' : ''}</span>
                      <span className="lbl">
                        {row.label}
                        <small>{row.sub}</small>
                      </span>
                    </button>
                    {'edit' in row && (
                      <button type="button" className="edit" aria-label={`${t('edit')} ${row.label}`} onClick={pick(row.edit)}>
                        {t('edit')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="mi" role="menuitem" onClick={pick(() => onDialog('settings'))}>
            <span className="ico">⚙</span>
            {t('settings')}
          </button>
          <button type="button" className="mi" role="menuitem" onClick={pick(() => onDialog('stats'))}>
            <span className="ico">▤</span>
            {t('statsLabel')}
          </button>
          <button type="button" className="mi" role="menuitem" onClick={pick(() => onDialog('keys'))}>
            <span className="ico">⌨</span>
            {t('shortcuts')}
            <kbd>?</kbd>
          </button>
          {account?.kind && (
            <>
              <hr />
              <button type="button" className="mi" role="menuitem" onClick={pick(() => void api.logout())}>
                <span className="ico">⏻</span>
                {t('signOut')}
              </button>
            </>
          )}
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

/** The prototype's `keyBody()`: provider switch, key, base URL; the saved key shows only its last four characters. */
export function ApiKeyDialog({
  t,
  api,
  provider: initial,
  onClose,
}: {
  t: T
  api: AccountApi
  provider: AuthProvider
  onClose: () => void
}) {
  const [provider, setProvider] = useState(initial)
  const stored = keyOf(api.account, provider)
  const saved = !!stored?.source
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(stored?.base_url ?? '')
  const [error, setError] = useState<{ field: 'key' | 'base' | 'server'; text: string }>()
  const [busy, setBusy] = useState(false)
  const switchTo = (next: AuthProvider) => {
    setProvider(next)
    setKey('')
    setBaseUrl(keyOf(api.account, next)?.base_url ?? '')
    setError(undefined)
  }
  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      onClose()
    } catch (err) {
      setError({ field: 'server', text: err instanceof Error ? err.message : String(err) })
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const base = baseUrl.trim().replace(/\/+$/, '')
    if (!key.trim() && !saved) return setError({ field: 'key', text: t('apiKeyRequired') })
    if (!isValidBaseUrl(base)) return setError({ field: 'base', text: t('baseUrlInvalid') })
    void act(() => api.saveKey(provider, key.trim(), base))
  }
  return (
    <Dialog t={t} title="API key" onClose={onClose}>
      <form className="keyform" id="apikey-form" noValidate onSubmit={submit}>
        <div className="seg" role="radiogroup" aria-label="Provider">
          {PROVIDERS.map(p => (
            <button type="button" role="radio" key={p} aria-checked={provider === p} onClick={() => switchTo(p)}>
              {PROVIDER_NAME[p]}
            </button>
          ))}
        </div>
        <label>
          <b>API key</b>
          <input
            id="ak-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={key}
            aria-invalid={error?.field === 'key' || undefined}
            placeholder={saved ? t('apiKeyKeep', { tail: stored?.tail ?? '' }) : provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
            onChange={e => setKey(e.target.value)}
          />
        </label>
        <label>
          <b>Base URL</b>
          <input
            id="ak-base"
            type="url"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            aria-invalid={error?.field === 'base' || undefined}
            placeholder={DEFAULT_BASE[provider]}
            onChange={e => setBaseUrl(e.target.value)}
          />
        </label>
        <span className="err" id="ak-err" role="alert">
          {error?.text}
        </span>
        <div className="btns">
          {saved && (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.removeKey(provider))}>
              {t('removeKey')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('saveAndUse')}
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
          <button className="btn" type="button" key={p} onClick={() => api.useKey(p, onKeyDialog)}>
            {t('useKey', { name: keyName(p) })}
          </button>
        ))}
      </div>
    </div>
  )
}
