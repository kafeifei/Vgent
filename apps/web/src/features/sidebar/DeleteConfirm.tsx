import { useEffect, useRef, useState } from "react";
import { PopItem, PopTitle } from "@/components/Popover";

/** Where a row's menu is between 「删除任务…」 and doing it. `files` is what deleting would lose; `undefined` = could not be counted. */
export type DeletePhase = "idle" | "checking" | { files: number | undefined };

/**
 * 删除任务 asks first, and for a worktree it asks with the number: the server
 * removes the directory with `git worktree remove --force`, so whatever was not
 * committed goes with it — the one thing this confirm has to say. Archiving
 * counts the same files (`onCheckUncommitted`) and keeps them; deleting does not.
 * A count that cannot be read is said as such rather than taken for zero.
 *
 * Mounted per opening of the menu (see `RowMenuItems`), so the count is always
 * fresh and a menu that closes on the way cancels the step.
 */
export function useDeleteConfirm(worktree: boolean, count: () => Promise<number>) {
  const [phase, setPhase] = useState<DeletePhase>("idle");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = (): void => {
    // Only a worktree still on disk has anything uncommitted for a delete to take.
    if (!worktree) {
      setPhase({ files: 0 });
      return;
    }
    setPhase("checking");
    void count()
      .then(
        (files) => files,
        () => undefined,
      )
      .then((files) => {
        if (alive.current) setPhase({ files });
      });
  };
  return { phase, start, cancel: () => setPhase("idle") };
}

/** What is lost that the ordinary sentence does not say, or `null` when nothing is. */
export function deleteWarning(files: number | undefined): string | null {
  if (files === 0) return null;
  return files == null ? "没能确认有没有没提交的改动，删除后无法找回。" : `${files} 个文件的改动没提交，会随 worktree 一起丢失。`;
}

/** The second step of 删除任务, in the menu that asked. */
export function DeleteConfirm({ files, onConfirm, onCancel }: { files: number | undefined; onConfirm: () => void; onCancel: () => void }) {
  const warning = deleteWarning(files);
  return (
    <>
      <PopTitle>删除这个任务？</PopTitle>
      {warning != null && <p className="m-0 px-xs pb-2xs text-danger text-xs leading-snug">{warning}</p>}
      <p className="m-0 px-xs pb-2xs text-fg-muted text-xs leading-snug">会删掉对话记录、worktree 和快照。分支上如果有提交会保留下来。</p>
      <PopItem shortcut="Enter" onClick={onConfirm}>
        <span className="text-danger">确认删除</span>
      </PopItem>
      <PopItem onClick={onCancel}>取消</PopItem>
    </>
  );
}
