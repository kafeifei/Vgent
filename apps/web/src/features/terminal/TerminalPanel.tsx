import { useEffect, useMemo, useRef } from "react";
import type { UIMessage } from "ai";
import type { InspectRequest } from "@/app/useWorkbench";
import { Spinner } from "@/features/worklog/ToolRow";
import { collectTerminalEntries, type TerminalEntry } from "./terminal";

/** Within this many pixels of the bottom counts as "at the bottom". */
const BOTTOM_SLOP = 24;

/** One command the agent ran: its invocation, then whatever it printed. */
function TerminalRow({ entry }: { entry: TerminalEntry }) {
  return (
    <div id={`term-${entry.id}`} className="mb-xs rounded-sm">
      <div className="flex items-center gap-xs text-fg-muted text-sm">
        {entry.state === "running" && <Spinner />}
        <span className="min-w-0 flex-1 truncate font-mono text-code text-fg">$ {entry.command}</span>
        {entry.state === "running" ? (
          <span className="flex-none text-fg-faint text-xs">运行中</span>
        ) : entry.exitCode != null && entry.exitCode !== 0 ? (
          <span className="flex-none rounded-full bg-danger-bg px-2xs font-mono text-2xs text-danger">
            exit {entry.exitCode}
          </span>
        ) : null}
      </div>
      {entry.output != null && entry.output !== "" && (
        <pre className="mt-2xs max-h-[calc(var(--spacing-3xl)*6)] overflow-auto whitespace-pre-wrap rounded-sm bg-bg-inset px-xs py-2xs font-mono text-code text-fg-muted leading-code">
          {entry.output}
        </pre>
      )}
    </div>
  );
}

/**
 * 终端 tab: every shell command the agent has run, in chronological order.
 * Owns its own scroll container so it can follow the bottom as output grows —
 * but only while the user has not scrolled away from it.
 */
export function TerminalPanel({
  messages,
  focus,
}: {
  messages: UIMessage[];
  /** A command row in the log was clicked: scroll to that command and flash it. */
  focus?: InspectRequest | null;
}) {
  // Only the agent's own commands: the worktree's setup script is not one of
  // them, and — as in Cursor — its output shows nowhere but under a failed setup.
  const entries = useMemo(() => collectTerminalEntries(messages), [messages]);
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el == null) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el == null || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  // The row asked for is brought into view and flashed; following the bottom
  // stops, or the next line of output would pull it away again.
  useEffect(() => {
    if (focus == null) return;
    const element = document.getElementById(`term-${focus.toolCallId}`);
    if (element == null) return;
    atBottomRef.current = false;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.add("ring-2", "ring-focus-ring");
    const timer = setTimeout(() => element.classList.remove("ring-2", "ring-focus-ring"), 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  if (entries.length === 0) {
    return <p className="text-fg-faint text-xs">本任务还没有运行过命令</p>;
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto">
      {entries.map((entry) => (
        <TerminalRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
