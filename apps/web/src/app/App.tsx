import { useEffect, useState } from "react";
import { bootstrapToken, setToken, UNAUTHORIZED_EVENT } from "@/lib/api";
import { ToastProvider } from "@/lib/toast";
import { Shell } from "./Shell";
import { isImeKeyEvent } from "@/lib/ime";

/**
 * The app is nothing but the token gate plus the shell: everything else lives
 * in `src/features/*` and `src/lib/*`.
 */
export function App() {
  const [token, setTokenState] = useState<string | null>(() => bootstrapToken());

  useEffect(() => {
    // A rejected token unmounts the shell, which disposes every chat and the
    // SSE connection with it — nothing is left to retry with the dead token.
    const onUnauthorized = () => setTokenState(null);
    // A `#token=…` pasted into an already-open tab takes effect without a
    // reload: `bootstrapToken` prefers the hash over what is stored.
    const onHashChange = () => setTokenState(bootstrapToken());
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  return (
    <ToastProvider>
      {token == null ? <TokenGate onToken={setTokenState} /> : <Shell key={token} token={token} />}
    </ToastProvider>
  );
}

/** Shown when the URL carried no `#token=…` and none is in sessionStorage. */
function TokenGate({ onToken }: { onToken: (token: string) => void }) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (draft.trim() === "") return;
    setToken(draft.trim());
    onToken(draft.trim());
  };

  return (
    <div className="grid h-full place-items-center px-md">
      <div className="w-full max-w-[calc(var(--spacing-3xl)*8)] rounded-lg border border-border bg-bg-elevated p-lg">
        <h1 className="m-0 mb-2xs font-semibold text-lg">需要 token</h1>
        <p className="m-0 mb-md text-fg-muted text-sm">
          服务端启动时会把 token 写进 <code className="font-mono text-code">~/.vgent/connection.json</code>，
          也可以直接用 <code className="font-mono text-code">#token=…</code> 打开本页。
        </p>
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKeyEvent(event)) return;
            if (event.key === "Enter") submit();
          }}
          placeholder="x-vgent-token"
          className="w-full rounded-sm border border-border bg-bg-inset px-sm py-xs font-mono text-code outline-none placeholder:text-fg-faint focus-visible:border-border-strong"
        />
        <button
          type="button"
          onClick={submit}
          className="mt-sm inline-flex h-xl items-center rounded-md border border-brand bg-brand px-sm font-semibold text-brand-fg text-xs hover:bg-brand-hover"
        >
          保存
        </button>
      </div>
    </div>
  );
}
