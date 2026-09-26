import { FolderOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PopItem, PopTitle, Popover } from "./Popover";
import { ApiError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { Project } from "@/lib/types";
import { isImeKeyEvent } from "@/lib/ime";
import { NO_PROJECT_ID, NO_PROJECT_NAME, isNoProject } from "@/lib/noProject";

/**
 * The workspace opener and new-task project selector share folder picking. Adding a
 * project opens the native folder chooser — typing a path is only the fallback
 * for a host that has no picker.
 */
export function ProjectPicker({
  projects,
  selectedId,
  onSelect,
  onAdd,
  onPickFolder,
  trigger,
  align = "start",
  purpose = "task",
}: {
  projects: Project[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (repoPath: string) => Promise<void>;
  /** Resolves to the chosen directory, or `null` when the user cancelled. */
  onPickFolder: () => Promise<string | null>;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0]) => ReactNode;
  align?: "start" | "end";
  purpose?: "task" | "workspace";
}) {
  return (
    <Popover align={align} trigger={trigger}>
      {(close) => (
        <ProjectPanel
          projects={projects}
          selectedId={selectedId}
          onSelect={onSelect}
          onAdd={onAdd}
          onPickFolder={onPickFolder}
          close={close}
          purpose={purpose}
        />
      )}
    </Popover>
  );
}

function ProjectPanel({
  projects,
  selectedId,
  onSelect,
  onAdd,
  onPickFolder,
  close,
  purpose,
}: {
  projects: Project[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  close: () => void;
  purpose: "task" | "workspace";
}) {
  const toast = useToast();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = (repoPath: string) => {
    setBusy(true);
    return onAdd(repoPath)
      .then(() => {
        setPath("");
        setTyping(false);
        setError(null);
        close();
      })
      .catch((cause: Error) => {
        setError(cause.message);
        toast(cause.message);
      })
      .finally(() => setBusy(false));
  };

  const pick = () => {
    if (busy) return;
    setBusy(true);
    void onPickFolder()
      .then((repoPath) => (repoPath == null ? undefined : add(repoPath)))
      .catch((cause: Error) => {
        // No picker on this host (or it broke): let them type a path instead.
        if (cause instanceof ApiError && cause.code === "picker_unavailable") setTyping(true);
        toast(cause.message);
        setError(cause.message);
      })
      .finally(() => setBusy(false));
  };

  const submit = () => {
    if (path.trim() === "" || busy) return;
    void add(path.trim());
  };

  return (
    <>
      <PopTitle>{purpose === "workspace" ? "打开工作区" : "新任务所属项目"}</PopTitle>
      {projects.map((project) => (
        <PopItem
          key={project.id}
          selected={purpose === "task" && project.id === selectedId}
          disabled={busy}
          title={project.repoPath}
          onClick={() => {
            onSelect(project.id);
            close();
          }}
        >
          <span className="block truncate">{project.name}</span>
          <span className="block truncate font-mono text-2xs text-fg-faint">{project.repoPath}</span>
        </PopItem>
      ))}

      {/* 无项目: ask something, or do throwaway work, without pointing at a codebase. */}
      {purpose === "task" && (
        <PopItem
          selected={isNoProject(selectedId)}
          disabled={busy}
          onClick={() => {
            onSelect(NO_PROJECT_ID);
            close();
          }}
        >
          <span className="block truncate">{NO_PROJECT_NAME}</span>
          <span className="block truncate text-2xs text-fg-faint">在独立临时目录中开始任务</span>
        </PopItem>
      )}

      {projects.length > 0 && <div role="separator" className="my-2xs border-border border-t" />}
      <PopItem onClick={pick} disabled={busy}>
        <span className="inline-flex items-center gap-xs">
          <FolderOpen className="size-md" />
          {busy ? "打开中…" : "打开文件夹…"}
        </span>
      </PopItem>

      {typing && (
        <div className="p-2xs">
          <input
            autoFocus
            value={path}
            aria-label="文件夹路径"
            placeholder="/absolute/repo/path"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (isImeKeyEvent(event)) return;
              if (event.key === "Enter") submit();
              if (event.key === "Escape") setTyping(false);
            }}
            className="w-full rounded-sm border border-border bg-bg-inset px-xs py-2xs font-mono text-code outline-none placeholder:text-fg-faint focus-visible:border-border-strong"
          />
          {error != null && <div className="mt-2xs text-danger text-xs">{error}</div>}
          <button
            type="button"
            disabled={busy || path.trim() === ""}
            onClick={submit}
            className="mt-2xs inline-flex h-lg items-center rounded-sm border border-brand bg-brand px-xs font-semibold text-2xs text-brand-fg hover:bg-brand-hover disabled:opacity-50"
          >
            打开
          </button>
        </div>
      )}
    </>
  );
}
