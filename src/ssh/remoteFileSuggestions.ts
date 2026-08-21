import { createHash, timingSafeEqual } from 'crypto'
import { sep } from 'path'
import type {
  SDKControlSSHFileSuggestionsRequest,
  SDKControlSSHFileSuggestionsResponse,
  SSHFileSuggestionItem,
} from '../entrypoints/sdk/controlTypes.js'
import { getPathsForSuggestions } from '../hooks/fileSuggestions.js'
import { getPathCompletions } from '../utils/suggestions/directoryCompletion.js'

const DEFAULT_COLD_CACHE_WAIT_MS = 750
const DEFAULT_DEADLINE_MS = 1500
const MAX_RESPONSE_BYTES = 64 * 1024

type FuzzyIndex = {
  search: (
    query: string,
    limit: number,
  ) => Array<{ path: string; score?: number }>
}

type SSHEnvironment = Record<string, string | undefined>

export type RemoteFileSuggestionDependencies = {
  signal?: AbortSignal
  loadFuzzyIndex?: (signal?: AbortSignal) => Promise<FuzzyIndex>
  getPathSuggestions?: (
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<SSHFileSuggestionItem[]>
  coldCacheWaitMs?: number
  deadlineMs?: number
}

let fuzzyIndex:
  | { promise: Promise<FuzzyIndex>; controller: AbortController; consumers: number }
  | { promise: Promise<FuzzyIndex>; value: FuzzyIndex }
  | null = null

function loadBuiltinFuzzyIndex(signal?: AbortSignal): Promise<FuzzyIndex> {
  if (fuzzyIndex && 'value' in fuzzyIndex) return fuzzyIndex.promise

  if (!fuzzyIndex) {
    const controller = new AbortController()
    const state = {
      controller,
      consumers: 0,
      promise: Promise.resolve(undefined as unknown as FuzzyIndex),
    }
    state.promise = getPathsForSuggestions(controller.signal).then(
      value => {
        fuzzyIndex = { promise: Promise.resolve(value), value }
        return value
      },
      error => {
        if (fuzzyIndex === state) fuzzyIndex = null
        throw error
      },
    )
    fuzzyIndex = state
  }

  const state = fuzzyIndex
  if ('value' in state) return state.promise
  state.consumers += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    state.consumers -= 1
    if (state.consumers === 0 && fuzzyIndex === state) {
      fuzzyIndex = null
      state.controller.abort()
    }
  }
  if (signal?.aborted) {
    release()
    return Promise.reject(new Error('SSH file suggestion request cancelled'))
  }
  signal?.addEventListener('abort', release, { once: true })
  return state.promise.finally(() => {
    signal?.removeEventListener('abort', release)
    release()
  })
}

async function getBuiltinPathSuggestions(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SSHFileSuggestionItem[]> {
  const suggestions = await getPathCompletions(query, {
    maxResults: limit,
    signal,
  })
  return suggestions.map(suggestion => {
    const metadata = suggestion.metadata as { type?: unknown } | undefined
    const kind = metadata?.type === 'directory' ? 'directory' : 'file'
    return { path: String(suggestion.id), kind }
  })
}

function capabilityDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function assertManagedSSHCapability(
  requestToken: string,
  environment: SSHEnvironment = process.env,
): void {
  const expected = environment.CLAUDE_CODE_SSH_REMOTE_TOKEN
  const validContext =
    environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1' &&
    environment.CLAUDE_CODE_SSH_REMOTE === '1' &&
    typeof expected === 'string' &&
    expected.length > 0 &&
    requestToken.length > 0
  const matches =
    validContext &&
    timingSafeEqual(capabilityDigest(requestToken), capabilityDigest(expected))
  if (!matches) {
    throw new Error(
      'SSH control requests are only available in managed SSH sessions',
    )
  }
}

function validateRequest(request: SDKControlSSHFileSuggestionsRequest): void {
  if (
    request.version !== 1 ||
    request.query.length > 4096 ||
    request.query.includes('\0') ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 50 ||
    (request.mode !== 'fuzzy' && request.mode !== 'path')
  ) {
    throw new Error('Invalid SSH file suggestion request')
  }
}

function waitFor<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ status: 'value'; value: T } | { status: 'timeout' }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('SSH file suggestion request cancelled'))
      return
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve({ status: 'timeout' })
    }, timeoutMs)
    timeout.unref()
    const onAbort = () => {
      cleanup()
      reject(new Error('SSH file suggestion request cancelled'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        cleanup()
        resolve({ status: 'value', value })
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

function enforceResponseBound(
  items: SSHFileSuggestionItem[],
): SSHFileSuggestionItem[] {
  const bounded = [...items]
  while (
    bounded.length > 0 &&
    Buffer.byteLength(JSON.stringify({ items: bounded, incomplete: false })) >
      MAX_RESPONSE_BYTES
  ) {
    bounded.pop()
  }
  return bounded
}

export async function queryRemoteFileSuggestions(
  request: SDKControlSSHFileSuggestionsRequest,
  dependencies: RemoteFileSuggestionDependencies = {},
): Promise<SDKControlSSHFileSuggestionsResponse> {
  validateRequest(request)
  if (!request.query && request.show_on_empty !== true) {
    return { items: [], incomplete: false }
  }

  const signal = dependencies.signal
  const deadlineMs = dependencies.deadlineMs ?? DEFAULT_DEADLINE_MS
  if (request.mode === 'path' || request.query === '') {
    const result = await waitFor(
      (dependencies.getPathSuggestions ?? getBuiltinPathSuggestions)(
        request.query,
        request.limit,
        signal,
      ),
      deadlineMs,
      signal,
    )
    if (result.status === 'timeout') {
      throw new Error('SSH file suggestion request timed out')
    }
    return {
      items: enforceResponseBound(result.value.slice(0, request.limit)),
      incomplete: false,
    }
  }

  const providerController = new AbortController()
  const cancelProvider = () => providerController.abort()
  if (signal?.aborted) cancelProvider()
  else signal?.addEventListener('abort', cancelProvider, { once: true })

  const index = await waitFor(
    (dependencies.loadFuzzyIndex ?? loadBuiltinFuzzyIndex)(
      providerController.signal,
    ),
    Math.min(
      dependencies.coldCacheWaitMs ?? DEFAULT_COLD_CACHE_WAIT_MS,
      deadlineMs,
    ),
    signal,
  ).finally(() => {
    signal?.removeEventListener('abort', cancelProvider)
  })
  if (index.status === 'timeout') {
    return { items: [], incomplete: true }
  }

  const items = index.value
    .search(request.query, request.limit)
    .slice(0, request.limit)
    .map(result => ({
      path: result.path,
      kind:
        result.path.endsWith('/') || result.path.endsWith(sep)
          ? ('directory' as const)
          : ('file' as const),
      ...(typeof result.score === 'number' && Number.isFinite(result.score)
        ? { score: result.score }
        : {}),
    }))
  return { items: enforceResponseBound(items), incomplete: false }
}
