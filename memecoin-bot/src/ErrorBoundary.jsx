import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Caught render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, border: '1px solid #ff5d6c', borderRadius: 8, background: '#162233', color: '#ff5d6c', margin: '20px 0' }}>
          <div style={{ fontWeight: 'bold' }}>Something broke while rendering this section.</div>
          <div style={{ fontSize: 12, marginTop: 6, color: '#ffb74d', whiteSpace: 'pre-wrap' }}>{String(this.state.error?.message || this.state.error)}</div>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 10 }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
