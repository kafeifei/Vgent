import { useState, type ReactNode } from "react";
import { PopItem, PopTitle, Popover } from "./Popover";
import type { Project } from "@/lib/types";

/**
 * The project switcher, shared by the window bar and the empty state. Adding a
 * project asks for an absolute path inline, exactly like the smoke client did.
 */
export function ProjectPicker({
  projects,
  selectedId,
  onSelect,
  onAdd,
  trigger,
  align = "start",
}: {
  projects: Project[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (repoPath: string) => Promise<void>;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0]) => ReactNode;
  align?: "start" | "end";
}) {
  return (
    <Popover align={align} trigger={trigger}>
      {(close) => <ProjectPanel projects={projects} selectedId={selectedId} onSelect={onSelect} onAdd={onAdd} close={close} />}
    </Popover>
  );
}

function ProjectPanel({
  projects,
  selectedId,
  onSelect,
  onAdd,
  close,
}: {
  projects: Project[];
  selectedId: string | null;
  onSelect: (projectId: string) => void;
  onAdd: (repoPath: string) => Promise<void>;
  close: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (path.trim() === "" || busy) return;
    setBusy(true);
    void onAdd(path.trim())
      .then(() => {
        setPath("");
        setAdding(false);
        setError(null);
        close();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <PopTitle>项目</PopTitle>
      {projects.map((project) => (
        <PopItem
          key={project.id}
          selected={project.id === selectedId}
          onClick={() => {
            onSelect(project.id);
            close();
          }}
        >
          <span className="block truncate">{project.name}</span>
          <span className="block truncate font-mono text-2xs text-fg-faint">{project.repoPath}</span>
        </PopItem>
      ))}

      {adding ? (
        <div className="p-2xs">
          <input
            autoFocus
            value={path}
            placeholder="/absolute/repo/path"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") setAdding(false);
            }}
            className="w-full rounded-sm border border-border bg-bg-inset px-xs py-2xs font-mono text-code outline-none placeholder:text-fg-faint focus-visible:border-border-strong"
          />
          {error != null && <div className="mt-2xs text-danger text-xs">{error}</div>}
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="mt-2xs inline-flex h-lg items-center rounded-sm border border-brand bg-brand px-xs font-semibold text-2xs text-brand-fg hover:bg-brand-hover disabled:opacity-50"
          >
            添加
          </button>
        </div>
      ) : (
        <PopItem onClick={() => setAdding(true)}>添加项目…</PopItem>
      )}
    </>
  );
}
