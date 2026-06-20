import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { copyOpenAIAuthUrlToClipboard } from '../services/openai-oauth/clipboard.js'
import { loginOpenAIWithOAuth } from '../services/openai-oauth/index.js'
import { saveOpenAIApiKey } from '../services/openai-oauth/storage.js'
import { errorMessage } from '../utils/errors.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'

type LoginMethod = 'api_key' | 'oauth' | 'exit'

type OpenAIAuthStatus =
  | { state: 'choose' }
  | { state: 'api_key'; value: string; cursorOffset: number }
  | { state: 'saving_api_key' }
  | {
      state: 'waiting'
      authUrl: string | null
      clipboard: 'pending' | 'copied' | 'failed'
    }
  | { state: 'done'; message: string }
  | { state: 'error'; message: string }

export function OpenAIOAuthFlow(props: {
  onDone: () => void
  onExit?: () => void
  onError?: (error: Error) => void
}): React.ReactNode {
  const onDoneRef = React.useRef(props.onDone)
  const onExitRef = React.useRef(props.onExit)
  const onErrorRef = React.useRef(props.onError)
  const [status, setStatus] = React.useState<OpenAIAuthStatus>({ state: 'choose' })

  React.useEffect(() => {
    onDoneRef.current = props.onDone
    onExitRef.current = props.onExit
    onErrorRef.current = props.onError
  }, [props.onDone, props.onExit, props.onError])

  const handleExit = React.useCallback(() => {
    if (onExitRef.current) {
      onExitRef.current()
    } else {
      onDoneRef.current()
    }
  }, [])

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) {
      handleExit()
    }
  })

  const startOAuth = React.useCallback(() => {
    let cancelled = false
    setStatus({ state: 'waiting', authUrl: null, clipboard: 'pending' })

    void loginOpenAIWithOAuth({
      onAuthUrl: url => {
        if (cancelled) return
        setStatus({ state: 'waiting', authUrl: url, clipboard: 'pending' })
        void copyOpenAIAuthUrlToClipboard(url).then(copied => {
          if (!cancelled) {
            setStatus({
              state: 'waiting',
              authUrl: url,
              clipboard: copied ? 'copied' : 'failed',
            })
          }
        })
      },
    })
      .then(authPath => {
        if (cancelled) return
        setStatus({ state: 'done', message: `OpenAI login saved to ${authPath}` })
        onDoneRef.current()
      })
      .catch(error => {
        if (cancelled) return
        const err = error instanceof Error ? error : new Error(errorMessage(error))
        setStatus({ state: 'error', message: errorMessage(err) })
        onErrorRef.current?.(err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleMethod = React.useCallback(
    (method: LoginMethod) => {
      switch (method) {
        case 'api_key':
          setStatus({ state: 'api_key', value: '', cursorOffset: 0 })
          break
        case 'oauth':
          startOAuth()
          break
        case 'exit':
          handleExit()
          break
      }
    },
    [handleExit, startOAuth],
  )

  const saveApiKey = React.useCallback(async (value: string) => {
    const apiKey = value.trim()
    if (!apiKey) {
      setStatus({ state: 'error', message: 'OpenAI API key cannot be empty' })
      return
    }

    setStatus({ state: 'saving_api_key' })
    try {
      const authPath = await saveOpenAIApiKey(apiKey)
      setStatus({ state: 'done', message: `OpenAI API key saved to ${authPath}` })
      onDoneRef.current()
    } catch (error) {
      const err = error instanceof Error ? error : new Error(errorMessage(error))
      setStatus({ state: 'error', message: errorMessage(err) })
      onErrorRef.current?.(err)
    }
  }, [])

  return (
    <Box flexDirection="column" gap={1}>
      {status.state === 'choose' ? (
        <>
          <Text color="permission">Sign in to use OpenAI</Text>
          <Text dimColor>Choose how Claude Code should authenticate with OpenAI.</Text>
          <Select<LoginMethod>
            options={[
              {
                label: 'Use API key',
                value: 'api_key',
                description: 'Paste an OpenAI API key and save it to ~/.codex/auth.json',
              },
              {
                label: 'Sign in with OAuth',
                value: 'oauth',
                description: 'Open the browser and complete ChatGPT login',
              },
              {
                label: 'Exit',
                value: 'exit',
                description: 'Cancel OpenAI login',
              },
            ]}
            onChange={handleMethod}
            onCancel={handleExit}
          />
        </>
      ) : null}

      {status.state === 'api_key' ? (
        <>
          <Text color="permission">Enter OpenAI API key</Text>
          <Text dimColor>The key will be saved to ~/.codex/auth.json and will not be printed.</Text>
          <Box>
            <Text>API key: </Text>
            <TextInput
              value={status.value}
              onChange={value =>
                setStatus(current =>
                  current.state === 'api_key'
                    ? { ...current, value }
                    : current,
                )
              }
              onSubmit={saveApiKey}
              cursorOffset={status.cursorOffset}
              onChangeCursorOffset={cursorOffset =>
                setStatus(current =>
                  current.state === 'api_key'
                    ? { ...current, cursorOffset }
                    : current,
                )
              }
              columns={80}
              mask="*"
              onExit={handleExit}
            />
          </Box>
        </>
      ) : null}

      {status.state === 'saving_api_key' ? (
        <Text color="permission">Saving OpenAI API key...</Text>
      ) : null}

      {status.state === 'waiting' ? (
        <>
          <Text color="permission">Opening browser for OpenAI login...</Text>
          <Text dimColor>Complete the OpenAI login in your browser to continue.</Text>
          <Text>Open this URL:</Text>
          {status.authUrl ? <Text>{status.authUrl}</Text> : null}
          {status.clipboard === 'pending' ? (
            <Text dimColor>Copying login URL to clipboard...</Text>
          ) : null}
          {status.clipboard === 'copied' ? (
            <Text color="success">Login URL copied to clipboard.</Text>
          ) : null}
          {status.clipboard === 'failed' ? (
            <Text dimColor>Could not copy URL to clipboard. Copy the URL above manually.</Text>
          ) : null}
        </>
      ) : null}

      {status.state === 'done' ? <Text color="success">{status.message}</Text> : null}

      {status.state === 'error' ? (
        <>
          <Text color="error">{status.message}</Text>
          <Text dimColor>Press Esc or Ctrl+C to exit, or run /login again.</Text>
        </>
      ) : null}
    </Box>
  )
}
