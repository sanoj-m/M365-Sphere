import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="errboundary">
          <div className="card errboundary-card">
            <h1>M365Sphere</h1>
            <h2>Something went wrong</h2>
            <p className="bad-text mono">{String(this.state.error.message || this.state.error)}</p>
            <button className="btn primary" onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
