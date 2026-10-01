import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "@/features/settings/layout";
import { isImeKeyEvent } from "@/lib/ime";

/**
 * 归档 / 回收 from a menu, as Fumie does it: ask how many files the worktree
 * has not committed, go straight ahead when there are none, and otherwise hand
 * off to a dialog outside the menu. A count that cannot be read counts as dirty —
 * this step decides whether work leaves the disk, so it fails safe.
 */
export function useUncommittedGate(check: () => Promise<number>, proceed: () => void, confirm: (files: number | undefined) => void) {
  const [phase, setPhase] = useState<"idle" | "checking">("idle");
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
        setPhase("idle");
        if (files === 0) proceed();
        else confirm(files);
      });
  };
  return { phase, start };
}

/**
 * The confirm step lives outside the menu that asked. The changes are kept — in
 * git, until the task comes back — but only once the user has said so; files
 * git ignores are not kept at all, the setup rebuilds them.
 */
export function UncommittedConfirm({
  files,
  verb,
  comeBack,
  onConfirm,
  onCancel,
  returnFocusRef,
}: {
  files: number | undefined;
  verb: "归档" | "回收";
  /** The action that brings the changes back. */
  comeBack: string;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        className="gap-lg border-border bg-bg-elevated p-lg sm:max-w-[440px]"
        onOpenAutoFocus={(event) => { event.preventDefault(); confirmRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
        onEscapeKeyDown={(event) => { if (isImeKeyEvent(event)) event.preventDefault(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.repeat || isImeKeyEvent(event))) event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <DialogTitle className="text-fg leading-snug">带着没提交的改动{verb}？</DialogTitle>
        <DialogDescription className="text-fg-muted text-sm leading-relaxed">
          {files != null ? `${files} 个文件没提交` : "没能确认 worktree 是否干净"}。改动随任务保存，{comeBack}时放回；被 git 忽略的文件不保留。
        </DialogDescription>
        <div className="flex justify-end gap-xs">
          <button type="button" className={BUTTON_SECONDARY} onClick={onCancel}>取消</button>
          <button ref={confirmRef} type="button" className={BUTTON_PRIMARY} onClick={onConfirm}>确认{verb}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
