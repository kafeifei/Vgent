import { Archive } from "lucide-react";
import { LockedBar } from "./LockedBar";

/**
 * What stands where the composer was once a task is archived. 归档 means the
 * task is put away — the server refuses a new turn on it — so there is nothing
 * to type into; the one way on is to take it back out.
 */
export function ArchivedBar({ onUnarchive }: { onUnarchive: () => void }) {
  return (
    <LockedBar label="已归档" icon={<Archive className="size-md flex-none text-fg-faint" />}>
      <button
        type="button"
        onClick={onUnarchive}
        className="inline-flex h-7 flex-none items-center rounded-full border border-border px-sm text-fg hover:border-border-strong hover:bg-bg-hover"
      >
        取消归档
      </button>
    </LockedBar>
  );
}
