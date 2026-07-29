import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Without this a render error leaves the window painted in the background
 * colour and nothing else, which is indistinguishable from a slow start. The
 * failure should be readable without opening devtools.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] упал рендер', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
  }

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const bridgeMissing = typeof window !== 'undefined' && !window.zmtki;

    return (
      <div className="crash">
        <h1>Интерфейс не запустился</h1>
        <p className="crash-message">{error.message}</p>
        {bridgeMissing && (
          <p className="crash-hint">
            Мост preload недоступен: <code>window.zmtki</code> не определён. Обычно это значит, что
            preload-скрипт не загрузился — смотри ошибки в терминале, где запущен <code>pnpm dev</code>.
          </p>
        )}
        <pre className="crash-stack">{stack || error.stack}</pre>
        <button type="button" onClick={() => location.reload()}>
          Перезагрузить
        </button>
      </div>
    );
  }
}
