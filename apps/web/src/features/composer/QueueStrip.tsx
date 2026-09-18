import { useState } from "react";
import { Pencil, Send, X } from "lucide-react";
import type { QueuedMessage } from "@/lib/types";
import { isImeKeyEvent } from "@/lib/ime";

/**
 * 排队条, right above the textarea and inside the composer's frame — the queue
 * belongs to what you are about to say, not to the right column.
 *
 * `note` is why the queue is not moving: a stopped or failed turn leaves it
 * parked until the user decides, and a turn waiting on an approval is not over
 * either. When there is no live turn the head item also gets 「发送」, which is
 * how a paused queue is resumed by hand.
 */
export function QueueStrip({
  items,
  note,
  onSend,
  onEdit,
  onDelete,
}: {
  items: readonly QueuedMessage[];
  note?: string | undefined;
  /** Absent while the task is live: nothing may jump the running turn. */
  onSend?: ((itemId: string) => void) | undefined;
  onEdit: (itemId: string, text: string) => void;
  onDelete: (itemId: string) => void;
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

  return (
    <div className="border-border border-b px-xs pt-2xs pb-3xs">
      <div className="flex items-center gap-xs px-3xs pb-3xs">
        <span className="text-fg-muted text-xs">排队 {items.length}</span>
        {note != null && <span className="min-w-0 truncate text-fg-faint text-xs">{note}</span>}
      </div>
      {items.map((item, index) => (
        <div key={item.id} className="group flex h-row-file items-center gap-2xs rounded-sm px-3xs hover:bg-bg-hover">
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
            <span title={item.text} className="min-w-0 flex-1 truncate text-fg-muted text-xs">
              {item.text}
            </span>
          )}
          {/* 发送 only on the head item, and only when nothing is running. */}
          {index === 0 && onSend != null && editing?.id !== item.id && (
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
          {editing?.id !== item.id && (
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
