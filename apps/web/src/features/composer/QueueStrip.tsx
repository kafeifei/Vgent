import { useState } from "react";
import { ArrowDown, ArrowUp, CornerUpRight, Pencil, Send, X } from "lucide-react";
import type { QueuedMessage } from "@/lib/types";
import { isImeKeyEvent } from "@/lib/ime";
import { cn } from "@/lib/utils";

/**
 * Pending steer and next-turn queue items stay visible above the composer.
 * A steer can be interrupted and sent as a new turn until the agent reads it.
 */
export function QueueStrip({
  items,
  note,
  onSend,
  onInterrupt,
  onEdit,
  onDelete,
  onReorder,
  onSteer,
}: {
  items: readonly QueuedMessage[];
  note?: string | undefined;
  /** Absent while the task is live: nothing may jump the running turn. */
  onSend?: ((itemId: string) => void) | undefined;
  /** Present while live: stop the turn, then send the chosen item. */
  onInterrupt?: ((itemId: string) => void) | undefined;
  onEdit: (itemId: string, text: string) => void;
  onDelete: (itemId: string) => void;
  onReorder?: ((ids: readonly string[]) => void) | undefined;
  onSteer?: ((itemId: string) => void) | undefined;
}) {
  /** The item being edited in place, with its unsaved text. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  if (items.length === 0) return null;

  const save = (): void => {
    if (editing == null) return;
    const text = editing.text.trim();
    // An emptied item is a mistake, not a delete — 删除 is right there.
    if (text !== "") onEdit(editing.id, text);
    setEditing(null);
  };

  const move = (index: number, offset: number): void => {
    const ids = items.map((item) => item.id);
    const other = index + offset;
    if (other < 0 || other >= ids.length) return;
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    onReorder?.(ids);
  };

  return (
    <div className="border-border border-b px-xs py-3xs">
      {items.map((item, index) => (
        <div key={item.id} className="group flex h-row-file items-center gap-2xs rounded-sm px-3xs hover:bg-bg-hover">
          <span className={cn("w-24 flex-none truncate text-xs", item.mode === "steer" ? "text-brand" : "text-fg-muted")}>
            {item.mode === "steer" ? (item.applied === true ? "引导已送入" : item.accepted === true ? "引导已接收" : "引导待送入") : `排队 ${items.filter((entry) => entry.mode !== "steer").length}`}
          </span>
          {index === 0 && note != null && <span className="max-w-[40%] flex-none truncate text-fg-faint text-xs">{note}</span>}
          {editing?.id === item.id ? (
            <input
              autoFocus
              value={editing.text}
              onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
              onBlur={save}
              onKeyDown={(event) => {
                if (isImeKeyEvent(event)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  save();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(null);
                }
              }}
              className="min-w-0 flex-1 rounded-sm border border-border-strong bg-bg-inset px-2xs py-3xs text-fg text-xs outline-none"
            />
          ) : (
            <span title={item.text} className="min-w-0 flex-1 truncate text-fg text-xs">
              {item.text}
            </span>
          )}
          {/* 发送 only on the head item, and only when nothing is running. */}
          {index === 0 && onSend != null && editing?.id !== item.id && item.accepted !== true && (
            <button
              type="button"
              title="现在发送这条"
              onClick={() => onSend(item.id)}
              className="inline-flex h-lg flex-none items-center gap-3xs rounded-sm px-2xs text-brand text-xs hover:bg-bg-active"
            >
              <Send className="size-sm" />
              <span>发送</span>
            </button>
          )}
          {onInterrupt != null && editing?.id !== item.id && item.applied !== true && (item.mode === "steer" || index === 0) && (
            <button
              type="button"
              title="停下当前这一轮，马上发这条"
              onClick={() => onInterrupt(item.id)}
              className="inline-flex h-lg flex-none items-center gap-3xs rounded-sm px-2xs text-fg-muted text-xs hover:bg-bg-active hover:text-fg"
            >
              <Send className="size-sm" />
              <span>打断并发送</span>
            </button>
          )}
          {item.mode !== "steer" && onSteer != null && onInterrupt != null && (
            <button type="button" title="把这条消息引导进当前回合" onClick={() => onSteer(item.id)} className="inline-flex h-lg flex-none items-center gap-3xs rounded-sm px-2xs text-fg-muted text-xs hover:bg-bg-active hover:text-fg">
              <CornerUpRight className="size-sm" />引导
            </button>
          )}
          {item.accepted !== true && onReorder != null && (
            <>
              <button type="button" aria-label="上移" title="上移" disabled={index === 0 || items[index - 1]?.accepted === true} onClick={() => move(index, -1)} className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint hover:bg-bg-active hover:text-fg disabled:opacity-25"><ArrowUp className="size-sm" /></button>
              <button type="button" aria-label="下移" title="下移" disabled={index === items.length - 1 || items[index + 1]?.accepted === true} onClick={() => move(index, 1)} className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint hover:bg-bg-active hover:text-fg disabled:opacity-25"><ArrowDown className="size-sm" /></button>
            </>
          )}
          {editing?.id !== item.id && item.accepted !== true && (
            <>
              <button
                type="button"
                aria-label="编辑"
                title="编辑"
                onClick={() => setEditing({ id: item.id, text: item.text })}
                className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint opacity-0 hover:bg-bg-active hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Pencil className="size-sm" />
              </button>
              <button
                type="button"
                aria-label="删除"
                title="删除"
                onClick={() => onDelete(item.id)}
                className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint opacity-0 hover:bg-bg-active hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-sm" />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
