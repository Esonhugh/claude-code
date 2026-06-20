import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

function renderOpenAIAuthPage(options: {
  title: string
  message: string
  tone: 'success' | 'error'
}): string {
  const accent = options.tone === 'success' ? '#10a37f' : '#ef4444'
  const mark = options.tone === 'success' ? '✓' : '!'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${options.title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e5e7eb; }
    .card { max-width: 560px; margin: 24px; padding: 32px; border-radius: 20px; background: #111827; box-shadow: 0 24px 80px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08); }
    .mark { width: 48px; height: 48px; border-radius: 999px; display: grid; place-items: center; background: ${accent}; color: white; font-weight: 700; margin-bottom: 20px; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { margin: 0; line-height: 1.6; color: #cbd5e1; }
  </style>
</head>
<body>
  <main class="card">
    <div class="mark">${mark}</div>
    <h1>${options.title}</h1>
    <p>${options.message}</p>
  </main>
</body>
</html>`
}

function sendOpenAIAuthPage(
  res: ServerResponse,
  statusCode: number,
  options: {
    title: string
    message: string
    tone: 'success' | 'error'
  },
): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(renderOpenAIAuthPage(options))
}

export class OpenAIAuthCodeListener {
  private localServer: Server
  private port = 0
  private expectedState: string | null = null
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  private promiseRejecter: ((error: Error) => void) | null = null

  constructor(private readonly callbackPath: string = '/callback') {
    this.localServer = createServer()
  }

  async start(port = 1455): Promise<number> {
    return new Promise((resolve, reject) => {
      this.localServer.once('error', err => {
        reject(
          new Error(`Failed to start OpenAI OAuth callback server: ${err.message}`),
        )
      })
      this.localServer.listen(port, 'localhost', () => {
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      this.expectedState = state
      this.localServer.on('request', this.handleRedirect.bind(this))
      this.localServer.on('error', this.reject.bind(this))
      void Promise.resolve()
        .then(onReady)
        .catch(error => {
          this.reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  close(): void {
    this.localServer.removeAllListeners()
    this.localServer.close()
  }

  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )
    if (parsedUrl.pathname !== this.callbackPath) {
      sendOpenAIAuthPage(res, 404, {
        title: 'OpenAI login page not found',
        message: 'Return to Claude Code and restart the login flow.',
        tone: 'error',
      })
      return
    }

    const code = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    if (!code) {
      sendOpenAIAuthPage(res, 400, {
        title: 'OpenAI login failed',
        message: 'Return to Claude Code and try signing in again.',
        tone: 'error',
      })
      this.reject(new Error('No OpenAI authorization code received'))
      return
    }

    if (state !== this.expectedState) {
      sendOpenAIAuthPage(res, 400, {
        title: 'OpenAI login failed',
        message: 'Return to Claude Code and try signing in again.',
        tone: 'error',
      })
      this.reject(new Error('Invalid OpenAI OAuth state parameter'))
      return
    }

    sendOpenAIAuthPage(res, 200, {
      title: 'OpenAI login complete',
      message: 'You can close this tab and return to Claude Code.',
      tone: 'success',
    })
    this.resolve(code)
  }

  private resolve(authorizationCode: string): void {
    this.promiseResolver?.(authorizationCode)
    this.promiseResolver = null
    this.promiseRejecter = null
  }

  private reject(error: Error): void {
    this.promiseRejecter?.(error)
    this.promiseResolver = null
    this.promiseRejecter = null
  }
}
