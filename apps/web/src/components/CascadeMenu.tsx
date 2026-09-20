import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One row of a cascading menu. A row with `children` opens the next level; one with `onPick` is a choice. */
export interface CascadeNode {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** The current value, shown dimmed on the right of a row that opens a submenu. */
  hint?: string;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  /** A gap above this row: the start of a new group. */
  separated?: boolean;
  onPick?: () => void;
  children?: CascadeNode[];
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
export function CascadeLevel({ nodes, className }: { nodes: readonly CascadeNode[]; className?: string }) {
  const [active, setActive] = useState<{ key: string; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const activate = (node: CascadeNode, element: HTMLElement, now: boolean) => {
    cancel();
    const apply = () => setActive(node.children != null && node.disabled !== true ? { key: node.key, rect: element.getBoundingClientRect() } : null);
    if (now) apply();
    else timer.current = setTimeout(apply, HOVER_INTENT_MS);
  };

  const open = active == null ? undefined : nodes.find((node) => node.key === active.key);

  return (
    <>
      {/* The anchor rect is taken once, so a list that scrolls lets go of its submenu rather than leave it floating. */}
      <div className={className} onScroll={() => setActive(null)}>
        {nodes.map((node) => (
          <button
            key={node.key}
            type="button"
            role="menuitem"
            disabled={node.disabled === true}
            aria-haspopup={node.children != null ? "menu" : undefined}
            aria-expanded={node.children != null ? active?.key === node.key : undefined}
            {...(node.title != null ? { title: node.title } : {})}
            onMouseEnter={(event) => activate(node, event.currentTarget, false)}
            onMouseLeave={cancel}
            onClick={(event) => {
              if (node.onPick != null) node.onPick();
              else activate(node, event.currentTarget, true);
            }}
            className={cn(
              "flex w-full items-center gap-xs rounded-sm px-xs py-2xs text-left text-fg-muted text-sm hover:bg-bg-active hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted",
              active?.key === node.key && "bg-bg-active text-fg",
              node.separated === true && "mt-xs",
            )}
          >
            {node.icon}
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            {node.hint != null && <span className="flex-none text-fg-faint text-xs">{node.hint}</span>}
            {node.selected === true && <span className="flex-none text-brand">✓</span>}
            {node.children != null && <ChevronRight aria-hidden className="size-sm flex-none text-fg-faint" />}
          </button>
        ))}
      </div>
      {open?.children != null && active != null && (
        <Flyout anchor={active.rect}>
          <CascadeLevel nodes={open.children} />
        </Flyout>
      )}
    </>
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
