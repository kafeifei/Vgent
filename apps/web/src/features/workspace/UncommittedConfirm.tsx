import { useEffect, useRef, useState } from "react";
import { PopItem, PopTitle } from "@/components/Popover";

/** Where a menu is between its 归档 / 回收 row and doing it. */
export type UncommittedPhase = "idle" | "checking" | { files: number | undefined };

/**
 * 归档 / 回收 from a menu, as Fumie does it: ask how many files the worktree
 * has not committed, go straight ahead when there are none, and otherwise turn
 * the menu into one confirm step. A count that cannot be read counts as dirty —
 * this step decides whether work leaves the disk, so it fails safe.
 */
export function useUncommittedGate(check: () => Promise<number>, proceed: (preserveChanges: boolean) => void) {
  const [phase, setPhase] = useState<UncommittedPhase>("idle");
  // The menu can close while the count is on its way; a closed menu archives nothing.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = (): void => {
    setPhase("checking");
    void check()
      .then(
        (files) => files,
        () => undefined,
      )
      .then((files) => {
        if (!alive.current) return;
        if (files === 0) {
          setPhase("idle");
          proceed(false);
        } else setPhase({ files });
      });
  };
  return { phase, start, cancel: () => setPhase("idle") };
}

/**
 * The confirm step itself, in the menu that asked. The changes are kept — in
 * git, until the task comes back — but only once the user has said so; files
 * git ignores are not kept at all, the setup rebuilds them.
 */
export function UncommittedConfirm({
  files,
  verb,
  comeBack,
  onConfirm,
  onCancel,
}: {
  files: number | undefined;
  verb: "归档" | "回收";
  /** The action that brings the changes back. */
  comeBack: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <PopTitle>带着没提交的改动{verb}？</PopTitle>
      <p className="m-0 px-xs pb-2xs text-fg-muted text-xs leading-snug">
        {files != null ? `${files} 个文件没提交` : "没能确认 worktree 是否干净"}。改动随任务保存，{comeBack}时放回；被 git 忽略的文件不保留。
      </p>
      <PopItem shortcut="Enter" onClick={onConfirm}>
        确认{verb}
      </PopItem>
      <PopItem onClick={onCancel}>取消</PopItem>
    </>
  );
}
