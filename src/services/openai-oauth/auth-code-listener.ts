import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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
      res.writeHead(404)
      res.end()
      return
    }

    const code = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    if (!code) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No OpenAI authorization code received'))
      return
    }

    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid OpenAI OAuth state parameter'))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body>OpenAI login complete. You can close this tab.</body></html>')
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
