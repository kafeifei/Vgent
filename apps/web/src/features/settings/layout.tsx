import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { isImeKeyEvent } from "@/lib/ime";
import { cn } from "@/lib/utils";

/**
 * The pieces every settings page is made of: a page with a title, groups with
 * a small heading, and rows inside a group's card — what the row is on the
 * left, its control on the right.
 */

export function SettingsPage({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-xl">
      <div className="flex items-center gap-sm">
        <h2 className="min-w-0 flex-1 font-semibold text-fg text-lg">{title}</h2>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function SettingsGroup({ title, note, actions, children }: { title?: string; note?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-sm">
      {(title != null || actions != null) && (
        <div className="flex min-h-lg items-center gap-sm">
          {title != null && <h3 className="flex-1 font-medium text-fg-secondary text-sm">{title}</h3>}
          {actions}
        </div>
      )}
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg">{children}</div>
      {note != null && <p className="text-fg-faint text-sm">{note}</p>}
    </section>
  );
}

export function SettingsRow({
  title,
  help,
  leading,
  children,
  className,
}: {
  title: ReactNode;
  help?: ReactNode;
  /** An avatar or icon in front of the title. */
  leading?: ReactNode;
  /** The control, on the right. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-[calc(var(--spacing-row)*1.5)] items-center gap-md px-md py-sm", className)}>
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-3xs">
        <div className="flex min-w-0 items-center gap-xs text-fg text-md">{title}</div>
        {help != null && <div className="text-fg-muted text-sm">{help}</div>}
      </div>
      {children != null && <div className="flex flex-none items-center gap-xs">{children}</div>}
    </div>
  );
}

/** Shown inside a group's card when it has no rows. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <div className="px-md py-md text-fg-faint text-sm">{children}</div>;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="flex-none rounded-sm border border-border px-2xs text-fg-muted text-xs leading-[calc(var(--spacing-lg)-2px)]">{children}</span>;
}

/** A provider's avatar: its first letter, since there is no logo set to draw from. */
export function LetterAvatar({ name }: { name: string }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span aria-hidden className="grid size-xl flex-none place-items-center rounded-md border border-border bg-bg-elevated font-medium text-fg-secondary text-sm">
      {letter}
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-lg w-[calc(var(--spacing-lg)*1.75)] flex-none rounded-full border border-border bg-bg-inset transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        checked && "border-brand bg-brand",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 left-3xs size-[calc(var(--spacing-lg)-var(--spacing-2xs)-2px)] -translate-y-1/2 rounded-full bg-fg-muted transition-transform",
          checked && "translate-x-[calc(var(--spacing-lg)*0.75)] bg-brand-fg",
        )}
      />
    </button>
  );
}

export const BUTTON_SECONDARY =
  "inline-flex h-xl flex-none items-center gap-2xs rounded-md border border-border bg-bg-elevated px-sm text-fg text-sm hover:border-border-strong hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40";
export const BUTTON_GHOST =
  "inline-flex h-xl flex-none items-center gap-2xs rounded-md px-sm text-fg-muted text-sm hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";
export const BUTTON_PRIMARY =
  "inline-flex h-xl flex-none items-center gap-2xs rounded-md bg-brand px-md text-brand-fg text-sm disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A few mutually exclusive choices as one control: a sunken track with the
 * chosen segment raised — what macOS and Cursor use where a radio would be
 * too tall and a dropdown would hide the other options.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: string; title?: string }>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-xl flex-none items-center gap-3xs rounded-md bg-bg-inset p-3xs">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            "h-full rounded-sm px-sm text-fg-muted text-sm hover:text-fg",
            value === option.id && "bg-bg-elevated text-fg shadow-sm ring-1 ring-border",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A modal over the settings page. Esc closes the dialog and only the dialog:
 * it is taken in the capture phase, before the page's own Esc-to-leave sees it.
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKeyEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-30 flex items-start justify-center bg-bg-scrim pt-[calc(var(--spacing-3xl)*1.5)]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "flex max-h-[calc(100vh-var(--spacing-3xl)*3)] max-w-[calc(100%-var(--spacing-xl))] flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-lg ring-1 ring-border",
          wide === true ? "w-[calc(var(--spacing-log-max)*0.8)]" : "w-[calc(var(--spacing-log-max)*0.6)]",
        )}
      >
        <div className="flex items-center gap-sm border-border border-b px-lg py-sm">
          <h2 className="flex-1 truncate font-semibold text-fg text-lg">{title}</h2>
          <button type="button" title="关闭" onClick={onClose} className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg">
            <X className="size-md" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
