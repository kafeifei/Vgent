import { LIVE_REASON } from "@/lib/types";

/**
 * 恢复之后停在哪里, drawn across the log at that exact point. Everything below
 * it is dimmed: those turns still happened, their file changes just are not on
 * disk any more.
 *
 * 「回到最新」 is the undo, and it is not a toast that expires — it stays here
 * until the user either presses it or sends the next message.
 */
export function RestoredBar({ live, onLatest }: { live: boolean; onLatest: () => void }) {
  return (
    <div className="mb-block-gap flex items-center gap-xs rounded-md border border-border border-dashed bg-bg-inset px-md py-xs">
      <span className="min-w-0 flex-1 text-fg-muted text-xs">已恢复到这里，后面的改动已撤销</span>
      <button
        type="button"
        disabled={live}
        {...(live ? { title: LIVE_REASON } : {})}
        onClick={onLatest}
        className="inline-flex h-xl flex-none items-center rounded-sm border border-border px-xs text-fg-muted text-xs hover:border-border-strong hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        回到最新
      </button>
    </div>
  );
}
