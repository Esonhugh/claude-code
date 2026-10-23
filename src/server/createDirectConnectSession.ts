/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { DirectConnectConfig } from './directConnectManager.js'
import { connectResponseSchema } from './types.js'

/**
 * Errors thrown by createDirectConnectSession when the connection fails.
 */
export class DirectConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectConnectError'
  }
}

/**
 * Create a session on a direct-connect server.
 *
 * Posts to `${serverUrl}/sessions`, validates the response, and returns
 * a DirectConnectConfig ready for use by the REPL or headless runner.
 *
 * Throws DirectConnectError on network, HTTP, or response-parsing failures.
 */
export async function createDirectConnectSession({
  serverUrl,
  authToken,
  cwd,
  sessionKey,
  permissionMode,
  dangerouslySkipPermissions,
}: {
  serverUrl: string
  authToken?: string
  cwd: string
  sessionKey?: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
}): Promise<{
  config: DirectConnectConfig
  workDir?: string
}> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`
  }

  let resp: Response
  try {
    resp = await fetch(`${serverUrl}/sessions`, {
      method: 'POST',
      headers,
      body: jsonStringify({
        cwd,
        ...(sessionKey && { session_key: sessionKey }),
        ...((dangerouslySkipPermissions || permissionMode) && {
          permission_mode: dangerouslySkipPermissions
            ? 'bypassPermissions'
            : permissionMode,
        }),
      }),
    })
  } catch (err) {
    throw new DirectConnectError(
      `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`,
    )
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new DirectConnectError(
      `Failed to create session: ${resp.status} ${resp.statusText}${body ? ` \u2014 ${body}` : ''}`,
    )
  }

  const result = connectResponseSchema().safeParse(await resp.json())
  if (!result.success) {
    throw new DirectConnectError(
      `Invalid session response: ${result.error.message}`,
    )
  }

  const data = result.data
  return {
    config: {
      serverUrl,
      sessionId: data.session_id,
      wsUrl: data.ws_url,
      authToken,
    },
    workDir: data.work_dir,
  }
}

/** Best-effort `DELETE /sessions/:id` so a finished session does not linger. */
export async function deleteDirectConnectSession({
  serverUrl,
  sessionId,
  authToken,
}: DirectConnectConfig): Promise<void> {
  try {
    await fetch(`${serverUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    })
  } catch {
    // The server may already be gone; nothing to clean up then.
  }
}
