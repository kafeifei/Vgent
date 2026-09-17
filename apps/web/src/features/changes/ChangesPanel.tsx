import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { baseName } from "@/lib/format";
import type { ChangeStatus, ChangedFile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DiffView } from "./DiffView";
import { parseUnifiedDiff } from "./diff";
import { groupByDir } from "./paths";
import type { ChangesView } from "./useChanges";

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
  const { fileDiff, diffLoading, diffError, revert } = changes;
  const lines = useMemo(() => (fileDiff == null ? [] : parseUnifiedDiff(fileDiff.diff)), [fileDiff]);

  return (
    <div className="mt-2xs mb-xs">
      <div className="flex items-center gap-xs px-2xs pb-2xs pl-xs text-fg-faint text-xs">
        <span className="min-w-0 truncate font-mono text-code" title={file.path}>
          {file.oldPath != null ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <RevertButton onRevert={() => revert(file.path)} />
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

/** 变更 tab: the working tree against HEAD, one expandable diff at a time. */
export function ChangesPanel({ changes }: { changes: ChangesView }) {
  const { snapshot, loading, error, refresh, selected, select } = changes;
  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const groups = useMemo(() => groupByDir(files), [files]);
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFile = files.find((file) => file.path === selected);

  return (
    <>
      <div className="mb-xs flex items-center gap-xs text-fg-muted text-xs">
        <span className="flex-none">
          {files.length} 个文件 · <span className="font-mono text-diff-add-fg">+{added}</span>{" "}
          <span className="font-mono text-diff-del-fg">−{removed}</span>
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2xs">
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
        <p className="text-fg-faint text-xs">{loading && snapshot == null ? "加载中…" : "没有未提交的改动"}</p>
      ) : (
        <>
          {/* A chip in the log can open a file the snapshot no longer lists. */}
          {selected != null && selectedFile == null && (
            <p className="mb-xs text-fg-faint text-xs">该文件没有未提交的改动</p>
          )}
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
          <p className="mt-md text-2xs text-fg-faint">引擎直接写盘，这里没有「接受」——只有还原。</p>
        </>
      )}
    </>
  );
}
