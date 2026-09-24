import { Component, type ReactNode } from "react";

/**
 * The last line of defence: without it one throwing component (a lazy chunk
 * that failed to load, a bad message part) unmounts the whole tree and the
 * window is just blank. Reloading keeps the token — it lives in sessionStorage.
 */
export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render(): ReactNode {
    if (this.state.error == null) return this.props.children;
    return (
      <div className="grid h-full place-items-center px-md">
        <div className="flex max-w-[calc(var(--spacing-3xl)*10)] flex-col items-center gap-sm">
          <p className="m-0 break-all text-center font-mono text-code text-fg-muted">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-xl items-center rounded-md border border-brand bg-brand px-sm font-semibold text-brand-fg text-xs hover:bg-brand-hover"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
