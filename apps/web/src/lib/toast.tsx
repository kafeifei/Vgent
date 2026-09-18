import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

const TOAST_MS = 2200;
/** One with a button has to outlast a glance: the user still has to reach it. */
const ACTION_TOAST_MS = 8000;

/** An 「撤销」-style button riding along with the message. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export type Toast = (message: string, action?: ToastAction) => void;

const ToastContext = createContext<Toast | null>(null);

/** A one-line transient message, positioned and styled with tokens only. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ message: string; action?: ToastAction } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<Toast>((message, action) => {
    setCurrent({ message, ...(action != null ? { action } : {}) });
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCurrent(null), action != null ? ACTION_TOAST_MS : TOAST_MS);
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {current != null && (
        <div
          role="status"
          className="-translate-x-1/2 fixed bottom-2xl left-1/2 z-60 flex items-center gap-sm rounded-full bg-bg-elevated px-md py-xs text-fg text-sm shadow-popover"
        >
          <span>{current.message}</span>
          {current.action != null && (
            <button
              type="button"
              onClick={() => {
                const run = current.action?.onClick;
                setCurrent(null);
                run?.();
              }}
              className="-mr-2xs rounded-full px-xs py-3xs text-accent hover:bg-bg-hover"
            >
              {current.action.label}
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): Toast {
  const toast = useContext(ToastContext);
  if (toast == null) throw new Error("useToast 必须在 ToastProvider 内使用");
  return toast;
}
