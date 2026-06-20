import * as React from 'react'
import { Box, Text } from '../ink.js'
import { loginOpenAIWithOAuth } from '../services/openai-oauth/index.js'
import { errorMessage } from '../utils/errors.js'

export function OpenAIOAuthFlow(props: {
  onDone: () => void
  onError?: (error: Error) => void
}): React.ReactNode {
  const onDoneRef = React.useRef(props.onDone)
  const onErrorRef = React.useRef(props.onError)
  const [status, setStatus] = React.useState<'starting' | 'waiting' | 'done' | 'error'>('starting')
  const [message, setMessage] = React.useState('Starting OpenAI OAuth login...')
  const [authUrl, setAuthUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    onDoneRef.current = props.onDone
    onErrorRef.current = props.onError
  }, [props.onDone, props.onError])

  React.useEffect(() => {
    let cancelled = false
    setStatus('waiting')
    setMessage('Opening browser for OpenAI login...')

    void loginOpenAIWithOAuth({
      onAuthUrl: url => {
        if (!cancelled) setAuthUrl(url)
      },
    })
      .then(authPath => {
        if (cancelled) return
        setStatus('done')
        setMessage(`OpenAI login saved to ${authPath}`)
        onDoneRef.current()
      })
      .catch(error => {
        if (cancelled) return
        const err = error instanceof Error ? error : new Error(errorMessage(error))
        setStatus('error')
        setMessage(errorMessage(err))
        onErrorRef.current?.(err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Box flexDirection="column">
      <Text color={status === 'error' ? 'red' : status === 'done' ? 'green' : 'permission'}>
        {message}
      </Text>
      {status === 'waiting' ? (
        <>
          <Text dimColor>Complete the OpenAI login in your browser to continue.</Text>
          {authUrl ? <Text dimColor>Login URL: {authUrl}</Text> : null}
        </>
      ) : null}
    </Box>
  )
}
