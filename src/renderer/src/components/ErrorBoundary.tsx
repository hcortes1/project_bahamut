import { Component, type ReactNode } from 'react'

/** Keeps one failing screen from blanking the window. Retry remounts the screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="card lock-card stack" role="alert">
          <h2>This screen hit a problem</h2>
          <p>Nothing was lost. Try again, or open another screen.</p>
          <button type="button" className="btn primary" onClick={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}>
            Try again
          </button>
        </div>
      )
    }
    return <div key={this.state.attempt}>{this.props.children}</div>
  }
}
