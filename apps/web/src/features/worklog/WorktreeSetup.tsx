import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { ApiClient } from "@/lib/api";
import type { ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 「创建 worktree」 and 「运行 setup 脚本」 under the task's first message,
 * Cursor's two setup rows: a live label and a running clock while a phase
 * runs, the past tense and how long it took once it is done. The script's
 * output stays out of sight unless it failed — then its tail is shown right
 * under the reason, the way Cursor shows the last 2048 characters.
 */

type PhaseKey = "create" | "script";
type PhaseStatus = "running" | "completed" | "failed";

interface Phase {
  key: PhaseKey;
  status: PhaseStatus;
  startedAt?: string;
  finishedAt?: string;
}

const LABELS: Record<PhaseKey, Record<PhaseStatus, string>> = {
  create: { running: "正在创建 worktree", completed: "已创建 worktree", failed: "创建 worktree 失败" },
  script: { running: "正在运行 setup 脚本", completed: "已运行 setup 脚本", failed: "运行 setup 脚本失败" },
};

/** Cursor's cut of a failed script's output. */
const OUTPUT_TAIL_CHARS = 2048;

/** The phases this task has to show, in order; empty for a task that never had a worktree made for it. */
export function worktreePhases(thread: ThreadSummary): Phase[] {
  if (thread.workspaceState === "creating") return [{ key: "create", status: "running", startedAt: thread.createdAt }];
  if (thread.workspaceState === "failed") return [{ key: "create", status: "failed" }];
  const workspace = thread.workspace;
  if (workspace == null || (workspace.created == null && workspace.setup == null)) return [];
  const phases: Phase[] = [{ key: "create", status: "completed", ...workspace.created }];
  const setup = workspace.setup;
  if (setup != null) {
    phases.push({
      key: "script",
      status: setup.status === "running" ? "running" : setup.status === "ok" ? "completed" : "failed",
      startedAt: setup.startedAt,
      ...(setup.finishedAt != null ? { finishedAt: setup.finishedAt } : {}),
    });
  }
  return phases;
}

/** 「12s」「1m 5s」「2m」; nothing under a second. Cursor's format for a finished phase. */
function spent(ms: number): string | undefined {
  if (ms < 1000) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** The clock of a phase still running, from 0s up. */
function ticking(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function durationOf(phase: Phase, now: number): string | undefined {
  if (phase.startedAt == null) return undefined;
  const start = Date.parse(phase.startedAt);
  if (phase.status === "running") return ticking(now - start);
  return phase.finishedAt == null ? undefined : spent(Date.parse(phase.finishedAt) - start);
}

/** `Date.now()`, ticking once a second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

export function WorktreeSetup({ thread, client }: { thread: ThreadSummary; client: Pick<ApiClient, "getSetupLog"> }) {
  const phases = worktreePhases(thread);
  const now = useNow(phases.some((phase) => phase.status === "running"));
  const setup = thread.workspace?.setup;
  const scriptFailed = setup?.status === "failed";
  const [output, setOutput] = useState("");
  // The script's output is only ever shown once it has failed, so it is read then and only then.
  useEffect(() => {
    if (!scriptFailed) {
      setOutput("");
      return;
    }
    let cancelled = false;
    void client.getSetupLog(thread.id).then(
      (body) => {
        if (!cancelled) setOutput(body.log.trimEnd().slice(-OUTPUT_TAIL_CHARS));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, scriptFailed, thread.id]);

  if (phases.length === 0) return null;
  const failure =
    thread.workspaceState === "failed"
      ? thread.error
      : scriptFailed
        ? (setup.error ?? (setup.exitCode != null ? `setup 脚本失败，退出码 ${setup.exitCode}` : "setup 脚本失败"))
        : undefined;
  return (
    <div className="flex flex-col gap-xs px-chat-inset">
      {phases.map((phase) => (
        <PhaseRow key={phase.key} label={LABELS[phase.key][phase.status]} status={phase.status} duration={durationOf(phase, now)} />
      ))}
      {failure != null && (
        <>
          <p className="m-0 whitespace-pre-wrap break-words text-danger">{failure}</p>
          {output !== "" && <Output text={output} />}
        </>
      )}
    </div>
  );
}

function PhaseRow({ label, status, duration }: { label: string; status: PhaseStatus; duration: string | undefined }) {
  return (
    <div className={cn("flex items-center gap-2xs", status === "failed" ? "text-danger" : "text-fg-muted")}>
      {status === "running" ? <Shimmer as="span">{label}</Shimmer> : <span className="min-w-0 break-words">{label}</span>}
      {duration != null && <span className={status === "failed" ? "opacity-70" : "text-fg-faint"}>用时 {duration}</span>}
    </div>
  );
}

/** The tail of the output, opened at its last line — that is where the error is. */
function Output({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (ref.current != null) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="max-h-[calc(var(--spacing-3xl)*4)] overflow-y-auto whitespace-pre-wrap break-all rounded-sm bg-bg-inset p-xs font-mono text-fg-muted text-xs"
    >
      {text}
    </pre>
  );
}
