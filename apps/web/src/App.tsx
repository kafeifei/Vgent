import { useEffect, useState } from "react";
import { api, bootstrapToken, setToken, sseUrl } from "./api";
import { ThreadView } from "./ThreadView";
import type { PermissionMode, Project, StateEvent, ThreadSummary } from "./types";

function readThreadFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("thread");
}

function writeThreadToUrl(threadId: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (threadId == null) params.delete("thread");
  else params.set("thread", threadId);
  const query = params.toString();
  window.history.replaceState(null, "", query === "" ? window.location.pathname : `?${query}`);
}

export function App() {
  const [token, setTokenState] = useState<string | null>(() => bootstrapToken());
  const [draftToken, setDraftToken] = useState("");

  if (token == null) {
    return (
      <div style={{ gridColumn: "1 / -1", padding: 16 }}>
        <h3>需要 token</h3>
        <input
          value={draftToken}
          onChange={(event) => setDraftToken(event.target.value)}
          placeholder="x-vgent-token"
          size={48}
        />
        <button
          onClick={() => {
            if (draftToken === "") return;
            setToken(draftToken);
            setTokenState(draftToken);
          }}
        >
          保存
        </button>
      </div>
    );
  }

  return <Shell token={token} />;
}

function Shell({ token }: { token: string }) {
  const [state, setState] = useState<StateEvent | null>(null);
  const [sseError, setSseError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<string | null>(() => readThreadFromUrl());

  useEffect(() => {
    const source = new EventSource(sseUrl("/api/state", token));
    source.addEventListener("state", (event) => {
      setSseError(null);
      setState(JSON.parse((event as MessageEvent<string>).data) as StateEvent);
    });
    source.onerror = () => setSseError("state 流断开");
    return () => source.close();
  }, [token]);

  function selectThread(threadId: string | null) {
    setSelectedThread(threadId);
    writeThreadToUrl(threadId);
  }

  const projects = state?.projects ?? [];
  const threads = state?.threads ?? [];
  const projectId = selectedProject ?? projects[0]?.id ?? null;

  return (
    <>
      <aside style={{ overflowY: "auto", padding: 8, borderRight: "1px solid #ccc" }}>
        <div>state: {state == null ? "连接中…" : "已连接"} {sseError}</div>

        <h4>项目</h4>
        <ProjectForm token={token} />
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <label>
                <input
                  type="radio"
                  name="project"
                  checked={project.id === projectId}
                  onChange={() => setSelectedProject(project.id)}
                />
                {project.name} <code>{project.repoPath}</code>
              </label>
            </li>
          ))}
        </ul>

        <h4>会话</h4>
        {projectId != null && <ThreadForm token={token} projectId={projectId} onCreated={selectThread} />}
        <ul>
          {threads
            .filter((thread) => projectId == null || thread.projectId === projectId)
            .map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                token={token}
                selected={thread.id === selectedThread}
                onSelect={() => selectThread(thread.id)}
                onDeleted={() => selectThread(null)}
              />
            ))}
        </ul>
      </aside>

      <main style={{ overflowY: "auto", padding: 8 }}>
        {selectedThread == null ? (
          <p>选择一个会话</p>
        ) : (
          <ThreadView key={selectedThread} threadId={selectedThread} token={token} />
        )}
      </main>
    </>
  );
}

function ThreadItem({
  thread,
  token,
  selected,
  onSelect,
  onDeleted,
}: {
  thread: ThreadSummary;
  token: string;
  selected: boolean;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  return (
    <li>
      <button onClick={onSelect} style={{ fontWeight: selected ? "bold" : "normal" }}>
        {thread.title}
      </button>{" "}
      <small>
        {thread.status}
        {thread.error != null && ` · ${thread.error}`}
      </small>{" "}
      <button
        onClick={() => {
          void api(`/threads/${thread.id}`, token, { method: "DELETE" }).then(onDeleted);
        }}
      >
        删除
      </button>
    </li>
  );
}

function ProjectForm({ token }: { token: string }) {
  const [repoPath, setRepoPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (repoPath === "") return;
        void api<Project>("/projects", token, { method: "POST", json: { repoPath } })
          .then(() => {
            setRepoPath("");
            setError(null);
          })
          .catch((cause: Error) => setError(cause.message));
      }}
    >
      <input
        value={repoPath}
        onChange={(event) => setRepoPath(event.target.value)}
        placeholder="/absolute/repo/path"
        size={28}
      />
      <button type="submit">添加项目</button>
      {error != null && <div>{error}</div>}
    </form>
  );
}

function ThreadForm({
  token,
  projectId,
  onCreated,
}: {
  token: string;
  projectId: string;
  onCreated: (threadId: string) => void;
}) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("allow-reads");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void api<ThreadSummary>("/threads", token, {
          method: "POST",
          json: { projectId, permissionMode },
        })
          .then((thread) => {
            setError(null);
            onCreated(thread.id);
          })
          .catch((cause: Error) => setError(cause.message));
      }}
    >
      <select
        value={permissionMode}
        onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
      >
        <option value="allow-reads">allow-reads</option>
        <option value="allow-edits">allow-edits</option>
        <option value="allow-all">allow-all</option>
      </select>
      <button type="submit">新建会话</button>
      {error != null && <div>{error}</div>}
    </form>
  );
}
