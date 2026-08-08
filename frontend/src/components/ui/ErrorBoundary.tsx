/**
 * Keeps one broken panel from taking the whole workspace with it.
 *
 * The charts talk to a canvas library through imperative APIs, which is where
 * render-time throws tend to come from. Without a boundary, a single bad
 * colour or a null series blanks the entire page and hides the error behind a
 * white screen.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/primitives'

interface Props {
  children: ReactNode
  /** Shown above the error message, e.g. the symbol that failed. */
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Panel crashed', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="panel flex h-full flex-col items-center justify-center gap-2 rounded-lg p-4 text-center">
        <p className="text-xs font-medium">
          {this.props.label ? `${this.props.label} failed to render` : 'Something broke here'}
        </p>
        <p className="max-w-sm text-2xs leading-relaxed text-bear">{error.message}</p>
        <Button size="sm" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
