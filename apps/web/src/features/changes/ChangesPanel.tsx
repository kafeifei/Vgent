import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { baseName } from "@/lib/format";
import { LIVE_REASON, type ChangeStatus, type ChangedFile, type ThreadOutcome, type ThreadPullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DiffView } from "./DiffView";
import { ScopeToggle } from "./ScopeToggle";
import { parseUnifiedDiff } from "./diff";
import { groupByDir } from "./paths";
import type { ChangesView } from "./useChanges";
import { isImeKeyEvent } from "@/lib/ime";

const GLYPH: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

const GLYPH_COLOR: Record<ChangeStatus, string> = {
  modified: "text-fg-faint",
  added: "text-diff-add-fg",
  deleted: "text-diff-del-fg",
  renamed: "text-fg-faint",
  untracked: "text-diff-add-fg",
};

/** `+84 −12`, the same pair the work log's file chips show. */
function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex flex-none gap-2xs font-mono text-xs">
      {added > 0 && <span className="text-diff-add-fg">+{added}</span>}
      {removed > 0 && <span className="text-diff-del-fg">−{removed}</span>}
    </span>
  );
}

/** Two-step, inline: nothing here is undoable, and there is no 「接受」 either. */
function RevertButton({ onRevert }: { onRevert: () => void }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="ml-auto inline-flex h-xl flex-none items-center rounded-sm border border-border px-xs text-danger text-xs hover:border-danger hover:bg-danger-bg"
      >
        还原此文件
      </button>
    );
  }

  return (
    <span className="ml-auto flex flex-none items-center gap-2xs">
      <button
        type="button"
        onClick={() => {
          setArmed(false);
          onRevert();
        }}
        className="inline-flex h-xl items-center rounded-sm border border-danger bg-danger-bg px-xs text-danger text-xs"
      >
        确认还原
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="inline-flex h-xl items-center rounded-sm border border-border px-xs text-fg-muted text-xs hover:bg-bg-hover"
      >
        取消
      </button>
    </span>
  );
}

/** The selected file's diff, expanded right under its row. */
function DiffBlock({ file, changes }: { file: ChangedFile; changes: ChangesView }) {
  const { fileDiff, diffLoading, diffError, revert, scope } = changes;
  const lines = useMemo(() => (fileDiff == null ? [] : parseUnifiedDiff(fileDiff.diff)), [fileDiff]);

  return (
    <div className="mt-2xs mb-xs">
      <div className="flex items-center gap-xs px-2xs pb-2xs pl-xs text-fg-faint text-xs">
        <span className="min-w-0 truncate font-mono text-code" title={file.path}>
          {file.oldPath != null ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {/* 「上一轮」 is a diff between two past snapshots: there is nothing on
            disk it could put back, so it offers nothing to press. */}
        {scope === "all" && <RevertButton onRevert={() => revert(file.path)} />}
      </div>

      {diffError != null ? (
        <p className="px-xs text-danger text-xs">{diffError}</p>
      ) : file.binary || fileDiff?.binary === true ? (
        <p className="px-xs text-fg-faint text-xs">二进制文件</p>
      ) : fileDiff == null ? (
        <p className="px-xs text-fg-faint text-xs">{diffLoading ? "加载中…" : "没有可显示的 diff"}</p>
      ) : (
        <>
          <DiffView lines={lines} />
          {fileDiff.truncated && <p className="pt-2xs pl-xs text-2xs text-fg-faint">diff 过长，已截断</p>}
        </>
      )}
    </div>
  );
}

const BAR_BUTTON =
  "inline-flex h-xl flex-none items-center rounded-sm border border-border px-xs text-fg-muted text-xs hover:border-border-strong hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent";

/**
 * 收口: the bar under the file list. What it offers comes from the server's
 * integration status, so a task in the project's own checkout simply has fewer
 * buttons — nothing here decides that from the thread's shape.
 */
function ActionBar({
  changes,
  title,
  live,
  outcome,
  pr,
}: {
  changes: ChangesView;
  /** The default commit message. */
  title: string;
  live: boolean;
  outcome: ThreadOutcome | undefined;
  pr: ThreadPullRequest | undefined;
}) {
  const { integration, integrating, actionError, applyConflicts, dismissApplyConflicts, integrate } = changes;
  const [message, setMessage] = useState(title);
  const [composing, setComposing] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => setMessage(title), [title]);

  if (integration == null) return null;
  const blocked = live || integrating;
  // `live` covers a turn parked on an approval or a question too: its engine
  // still owns the working tree, which is exactly what these buttons move.
  const hint = live ? { title: LIVE_REASON } : {};
  const worktree = integration.mode === "worktree";
  const marked = applyConflicts?.filter((entry) => entry.resolution === "markers") ?? [];
  const skipped = applyConflicts?.filter((entry) => entry.resolution === "skipped") ?? [];

  const commit = () => {
    const text = message.trim();
    if (text === "") return;
    setComposing(false);
    integrate("commit", { message: text });
  };

  return (
    <div className="mt-md flex flex-col gap-2xs border-border border-t pt-sm">
      <div className="flex flex-wrap items-center gap-2xs">
        <button type="button" disabled={blocked || !integration.canCommit} {...hint} onClick={() => setComposing(true)} className={BAR_BUTTON}>
          提交
        </button>
        {integration.pr.available && (
          <button
            type="button"
            disabled={blocked}
            title={live ? LIVE_REASON : integration.pr.hint}
            onClick={() => integrate("pr", { message: message.trim() })}
            className={BAR_BUTTON}
          >
            开 PR
          </button>
        )}
        {worktree && (
          <button type="button" disabled={blocked || !integration.canApply} {...hint} onClick={() => integrate("apply")} className={BAR_BUTTON}>
            带回主目录
          </button>
        )}
        {worktree && integration.canUndoApply && (
          <button
            type="button"
            disabled={blocked}
            title={live ? LIVE_REASON : "把主检出里这次带回写下的文件放回去；你之后改过的不动"}
            onClick={() => integrate("undo-apply")}
            className={BAR_BUTTON}
          >
            撤销带回
          </button>
        )}
        {worktree && integration.canDiscardAll && !armed && (
          <button
            type="button"
            disabled={blocked}
            {...hint}
            onClick={() => setArmed(true)}
            className={cn(BAR_BUTTON, "text-danger hover:border-danger hover:bg-danger-bg")}
          >
            全部丢弃
          </button>
        )}
        {armed && (
          <>
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setArmed(false);
                integrate("discard");
              }}
              className={cn(BAR_BUTTON, "border-danger bg-danger-bg text-danger")}
            >
              确认丢弃全部
            </button>
            <button type="button" onClick={() => setArmed(false)} className={BAR_BUTTON}>
              取消
            </button>
          </>
        )}
        <OutcomeBadge outcome={outcome} pr={pr} className="ml-auto" />
      </div>

      {composing && (
        <input
          autoFocus
          value={message}
          placeholder="提交信息"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKeyEvent(event)) return;
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setComposing(false);
          }}
          onBlur={() => setComposing(false)}
          className="h-xl w-full rounded-sm border border-border bg-bg-elevated px-xs text-xs outline-none focus:border-border-strong"
        />
      )}

      {/*
        提交 in the user's own checkout only carries what the task changed — say
        how much that is, and that a file the user had already been editing goes
        in whole, their own lines with it.
      */}
      {(integration.commitFiles ?? 0) > 0 && (
        <p className="text-2xs text-fg-faint">
          {(integration.commitFilesWithOwnEdits ?? 0) > 0
            ? `提交 ${integration.commitFiles} 个文件，其中 ${integration.commitFilesWithOwnEdits} 个含你之前未提交的改动，会一起提交`
            : `提交 ${integration.commitFiles} 个文件（只提交这个任务改的）`}
        </p>
      )}
      {integration.note != null && <p className="text-2xs text-warning">{integration.note}</p>}
      {worktree && !integration.pr.available && integration.pr.reason != null && (
        <p className="text-2xs text-fg-faint">开 PR 不可用：{integration.pr.reason}</p>
      )}

      {/*
        A refused 带回: the list, then the only two things left to do. The
        confirm names the files that would get markers, because that is the
        choice — the rest is skipped either way.
      */}
      {applyConflicts != null ? (
        <div className="flex flex-col gap-2xs rounded-sm border border-border bg-bg-inset p-xs">
          <p className="text-warning text-xs">带回主目录停下了，主检出一个字节都没动。</p>
          <ul className="flex flex-col gap-3xs">
            {applyConflicts.map((entry) => (
              <li key={entry.path} className="truncate font-mono text-2xs text-fg-muted" title={`${entry.path}（${entry.reason}）`}>
                {entry.path} <span className="font-sans text-fg-faint">{entry.reason}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2xs">
            <button
              type="button"
              disabled={blocked || marked.length === 0}
              title={
                marked.length === 0
                  ? "这些文件都带不了冲突标记"
                  : `${marked.map((entry) => entry.path).join("、")} 会写入冲突标记${skipped.length > 0 ? `；另外 ${skipped.length} 个跳过` : ""}`
              }
              onClick={() => integrate("apply", { conflicts: "markers" })}
              className={BAR_BUTTON}
            >
              带冲突标记合并
            </button>
            <button type="button" onClick={dismissApplyConflicts} className={BAR_BUTTON}>
              取消
            </button>
          </div>
        </div>
      ) : (
        actionError != null && <p className="whitespace-pre-wrap text-danger text-xs">{actionError}</p>
      )}
    </div>
  );
}

/** 变更 tab: the task's diff against its baseline, one expandable diff at a time. */
export function ChangesPanel({
  changes,
  title,
  live,
  outcome,
  pr,
}: {
  changes: ChangesView;
  title: string;
  live: boolean;
  outcome: ThreadOutcome | undefined;
  pr: ThreadPullRequest | undefined;
}) {
  const { snapshot, loading, error, refresh, selected, select, scope, lastTurn } = changes;
  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const groups = useMemo(() => groupByDir(files), [files]);
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFile = files.find((file) => file.path === selected);
  const lastTurnScope = scope === "last-turn";

  return (
    <>
      {lastTurn && <ScopeToggle scope={scope} onScope={changes.setScope} />}

      <div className="mb-xs flex items-center gap-xs text-fg-muted text-xs">
        <span className="flex-none">
          {files.length} 个文件 · <span className="font-mono text-diff-add-fg">+{added}</span>{" "}
          <span className="font-mono text-diff-del-fg">−{removed}</span>
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2xs">
          {lastTurnScope && <span className="flex-none text-fg-faint">只看不改</span>}
          {!lastTurnScope && (changes.integration?.commitsAhead ?? 0) > 0 && (
            <span className="flex-none text-fg-faint">领先基线 {changes.integration?.commitsAhead} 个提交</span>
          )}
          {snapshot?.branch != null && (
            <span className="min-w-0 truncate font-mono text-code text-fg-faint" title={snapshot.branch}>
              {snapshot.branch}
            </span>
          )}
          <button
            type="button"
            aria-label="刷新"
            onClick={refresh}
            className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg"
          >
            <RefreshCw className={cn("size-md", loading && "animate-spin")} />
          </button>
        </span>
      </div>

      {error != null ? (
        <p className="text-danger text-xs">{error}</p>
      ) : files.length === 0 ? (
        <p className="text-fg-faint text-xs">
          {loading && snapshot == null ? "加载中…" : lastTurnScope ? "上一轮没有改动文件" : "没有未提交的改动"}
        </p>
      ) : (
        <>
          {/* A chip in the log can open a file the snapshot no longer lists. */}
          {selected != null && selectedFile == null && <p className="mb-xs text-fg-faint text-xs">该文件没有未提交的改动</p>}
          {groups.map((group) => (
            <div key={group.dir === "" ? "/" : group.dir}>
              <div className="truncate px-2xs pt-xs pb-3xs font-mono text-2xs text-fg-faint">
                {group.dir === "" ? "/" : group.dir}
              </div>
              {group.files.map((file) => (
                <div key={file.path} className="pl-sm">
                  <button
                    type="button"
                    title={file.path}
                    aria-expanded={selected === file.path}
                    onClick={() => select(selected === file.path ? null : file.path)}
                    className={cn(
                      "flex h-row-file w-full items-center gap-sm rounded-sm px-xs text-left hover:bg-bg-hover",
                      selected === file.path && "bg-bg-inset",
                    )}
                  >
                    <span className={cn("flex-none font-mono text-2xs", GLYPH_COLOR[file.status])}>
                      {GLYPH[file.status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-code text-fg-muted">
                      {baseName(file.path)}
                    </span>
                    <Stat added={file.additions} removed={file.deletions} />
                  </button>
                  {selected === file.path && <DiffBlock file={file} changes={changes} />}
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {error == null && !lastTurnScope && <ActionBar changes={changes} title={title} live={live} outcome={outcome} pr={pr} />}
    </>
  );
}
