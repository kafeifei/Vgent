import { ChevronRight } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One row of a cascading menu. A row with `children` or `content` opens the next
 * level; one with `onPick` is a choice; one with `toggle` is a switch it flips.
 */
export interface CascadeNode {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** The current value, shown dimmed on the right of a row that opens a submenu. */
  hint?: string;
  /** Optional second line for choices whose speed or cost needs explaining. */
  description?: string | undefined;
  /** A caption above this row; rows sharing one are captioned once, at the first. */
  section?: string;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  /** A rule above this row: the start of a new group. */
  separated?: boolean;
  /** Draws a switch in this state on the right; clicking the row flips it. */
  toggle?: boolean;
  onPick?: () => void;
  children?: CascadeNode[];
  /** A submenu that is not rows — the model list, which brings its own search box. */
  content?: ReactNode;
}

/** Long enough that crossing a neighbour on the way into a submenu does not switch it. */
const HOVER_INTENT_MS = 110;

const PANEL = "rounded-md bg-bg-elevated p-2xs shadow-popover";

/**
 * One level of a cascading menu, and — through the row under the pointer — the
 * levels after it. The next level is `position: fixed` next to its row, so the
 * scrolling list never clips it; it stays a DOM descendant of the popover panel,
 * which is what keeps the popover's outside-click from closing it.
 */
export function CascadeLevel({
  nodes,
  className,
  revealSelected = false,
}: {
  nodes: readonly CascadeNode[];
  className?: string;
  /** A list that scrolls opens on its selected row, not at the top — once, so searching does not jump it back. */
  revealSelected?: boolean;
}) {
  const [active, setActive] = useState<{ key: string; rect: DOMRect } | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const revealed = useRef(false);
  const selectedKey = nodes.find((node) => node.selected === true)?.key;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  // The catalog may still be loading when the menu opens: reveal the row the first time there is one.
  useLayoutEffect(() => {
    const container = list.current;
    if (!revealSelected || revealed.current || selectedKey == null || container == null) return;
    const row = container.querySelector<HTMLElement>("[data-selected]");
    if (row == null) return;
    revealed.current = true;
    const box = container.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    container.scrollTop += at.top - box.top - (box.height - at.height) / 2;
  }, [revealSelected, selectedKey]);

  const submenu = (node: CascadeNode): boolean => node.children != null || node.content != null;

  const activate = (node: CascadeNode, element: HTMLElement, now: boolean) => {
    cancel();
    const apply = () => setActive(submenu(node) && node.disabled !== true ? { key: node.key, rect: element.getBoundingClientRect() } : null);
    if (now) apply();
    else timer.current = setTimeout(apply, HOVER_INTENT_MS);
  };

  const open = active == null ? undefined : nodes.find((node) => node.key === active.key);

  return (
    <>
      {/* The anchor rect is taken once, so a list that scrolls lets go of its submenu rather than leave it floating. */}
      <div ref={list} className={className} onScroll={() => setActive(null)}>
        {nodes.map((node, at) => (
          <Fragment key={node.key}>
            {node.separated === true && at > 0 && <div aria-hidden className="my-2xs h-px bg-border" />}
            {node.section != null && node.section !== nodes[at - 1]?.section && (
              <div className="px-xs pt-xs pb-3xs text-fg-faint text-xs">{node.section}</div>
            )}
            <button
              type="button"
              role={node.toggle != null ? "menuitemcheckbox" : "menuitem"}
              {...(node.toggle != null ? { "aria-checked": node.toggle } : {})}
              disabled={node.disabled === true}
              aria-haspopup={submenu(node) ? "menu" : undefined}
              aria-expanded={submenu(node) ? active?.key === node.key : undefined}
              {...(node.title != null ? { title: node.title } : {})}
              {...(node.selected === true ? { "data-selected": "" } : {})}
              onMouseEnter={(event) => activate(node, event.currentTarget, false)}
              onMouseLeave={cancel}
              onClick={(event) => {
                if (node.onPick != null) node.onPick();
                else activate(node, event.currentTarget, true);
              }}
              className={cn(
                "flex w-full items-center gap-xs rounded-sm px-xs py-2xs text-left text-fg-muted text-sm hover:bg-bg-active hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted",
                active?.key === node.key && "bg-bg-active text-fg",
              )}
            >
              {node.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{node.label}</span>
                {node.description != null && <span className="mt-3xs block max-w-64 whitespace-normal text-xs leading-relaxed text-fg-faint">{node.description}</span>}
              </span>
              {node.hint != null && <span className="max-w-[18ch] flex-none truncate text-fg-faint text-xs">{node.hint}</span>}
              {node.toggle != null && <Toggle on={node.toggle} />}
              {node.selected === true && <span className="flex-none text-brand">✓</span>}
              {submenu(node) && <ChevronRight aria-hidden className="size-sm flex-none text-fg-faint" />}
            </button>
          </Fragment>
        ))}
      </div>
      {open != null && active != null && (open.content != null || open.children != null) && (
        <Flyout anchor={active.rect}>{open.content ?? <CascadeLevel nodes={open.children ?? []} />}</Flyout>
      )}
    </>
  );
}

/**
 * The switch on a toggle row. A span rather than a button — the row it sits in
 * is the button, and it is what the click has to reach.
 */
function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative h-md w-[calc(var(--spacing-md)*1.75)] flex-none rounded-full border border-border bg-bg-inset transition-colors",
        on && "border-brand bg-brand",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 left-px size-[calc(var(--spacing-md)-4px)] -translate-y-1/2 rounded-full bg-fg-muted transition-transform",
          on && "translate-x-[calc(var(--spacing-md)*0.75)] bg-brand-fg",
        )}
      />
    </span>
  );
}

/** A submenu panel beside its row: to the right when it fits, else to the left; never off the bottom. */
function Flyout({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const panel = ref.current?.getBoundingClientRect();
    if (panel == null) return;
    const right = anchor.right + 2;
    const left = right + panel.width <= window.innerWidth - 4 ? right : Math.max(4, anchor.left - 2 - panel.width);
    const top = Math.max(4, Math.min(anchor.top - 4, window.innerHeight - panel.height - 4));
    setPosition({ left, top });
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
      className={cn("fixed z-40 min-w-[calc(var(--spacing-3xl)*2.4)] max-w-[calc(var(--spacing-3xl)*5)]", PANEL)}
    >
      {children}
    </div>
  );
}
