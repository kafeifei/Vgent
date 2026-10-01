import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
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
 * A modal over the settings page, on Radix's Dialog: while it is open focus is
 * trapped inside it, the page behind is hidden from assistive technology and
 * takes no pointer, Esc and a press on the scrim close it. Esc closes the
 * dialog and only the dialog — the page's own Esc-to-leave never hears it.
 *
 * It is portalled to the body, outside the page it covers, so hiding that page
 * does not hide it. The scrim and the panel are one `Overlay` around one
 * `Content`, laid out as they always were. Nothing in the panel may sit under a
 * transform: the popovers inside it are `position: fixed`, and would be placed
 * against the panel instead of the window.
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  // Radix gives focus back to a `Dialog.Trigger`; these open from ordinary
  // buttons and menu rows, so the element that had focus just before is kept
  // here. Read once the dialog has mounted and before its content does.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogShell
          title={title}
          {...(wide === true ? { wide } : {})}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected === true) opener.current.focus();
          }}
        >
          {children}
        </DialogShell>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The dialog's scrim and panel; needs the Radix `Dialog.Root` above it. */
export function DialogShell({
  title,
  wide,
  onCloseAutoFocus,
  children,
}: {
  title: string;
  wide?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Overlay className="fixed inset-0 z-30 flex items-start justify-center bg-bg-scrim pt-[calc(var(--spacing-3xl)*1.5)]">
      <DialogPrimitive.Content
        // No description to point at: the title names it, the body is the form.
        aria-describedby={undefined}
        aria-modal="true"
        onEscapeKeyDown={(event) => {
          // An input method's Esc cancels its candidate, not the dialog.
          if (isImeKeyEvent(event)) event.preventDefault();
          else event.stopPropagation();
        }}
        {...(onCloseAutoFocus != null ? { onCloseAutoFocus } : {})}
        className={cn(
          "flex max-h-[calc(100vh-var(--spacing-3xl)*3)] max-w-[calc(100%-var(--spacing-xl))] flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-lg ring-1 ring-border outline-hidden",
          wide === true ? "w-[calc(var(--spacing-log-max)*0.8)]" : "w-[calc(var(--spacing-log-max)*0.6)]",
        )}
      >
        <div className="flex items-center gap-sm border-border border-b px-lg py-sm">
          <DialogPrimitive.Title className="flex-1 truncate font-semibold text-fg text-lg">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <button type="button" title="关闭" aria-label="关闭" className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg">
              <X className="size-md" />
            </button>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  );
}
