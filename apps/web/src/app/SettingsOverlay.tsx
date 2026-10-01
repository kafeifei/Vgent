import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "./useModalFocus";

/**
 * 设置 floats over the workbench like Cursor's: the columns stay put underneath,
 * dimmed and softly blurred, and come back untouched on close.
 *
 * It is a modal, and behaves as one. The caller makes what is behind it `inert`
 * while this is mounted, so nothing there can be focused or clicked; focus goes
 * into the dialog when it appears, Tab stays inside it, and focus goes back to
 * where it came from when it goes (`useModalFocus`). Esc closes it — that key is
 * `SettingsView`'s, which knows whether a popover inside should take it first —
 * and so does a press on the dimmed area.
 */
export function SettingsOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement | null>(null);
  // Mounted only while open, so "open" is simply "here".
  const trapTab = useModalFocus(true, dialog);
  return (
    <div
      role="presentation"
      className="fixed inset-0 z-20 flex items-center justify-center bg-bg-scrim p-2xl backdrop-blur-xs"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        onKeyDown={trapTab}
        className="relative flex h-full max-h-[calc(var(--spacing-3xl)*15)] w-full max-w-[calc(var(--spacing-log-max)+var(--spacing-3xl)*3)] min-h-0 flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-lg ring-1 ring-border-strong outline-none"
      >
        <button
          type="button"
          title="关闭"
          onClick={onClose}
          className="absolute top-sm right-sm z-10 grid size-lg place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="size-md" />
        </button>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
