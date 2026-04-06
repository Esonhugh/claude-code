import * as React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export class SentryErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    // @ts-ignore - recovered code
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  render(): React.ReactNode {
    // @ts-ignore - recovered code
    if (this.state.hasError) {
      return null
    }

    // @ts-ignore - recovered code
    return this.props.children
  }
}
