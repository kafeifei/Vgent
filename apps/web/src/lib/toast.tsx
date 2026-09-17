import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

const TOAST_MS = 2200;

const ToastContext = createContext<((message: string) => void) | null>(null);

/** A one-line transient message, positioned and styled with tokens only. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((next: string) => {
    setMessage(next);
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {message != null && (
        <div
          role="status"
          className="-translate-x-1/2 fixed bottom-2xl left-1/2 z-60 rounded-full bg-bg-elevated px-md py-xs text-fg text-sm shadow-popover"
        >
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string) => void {
  const toast = useContext(ToastContext);
  if (toast == null) throw new Error("useToast 必须在 ToastProvider 内使用");
  return toast;
}
