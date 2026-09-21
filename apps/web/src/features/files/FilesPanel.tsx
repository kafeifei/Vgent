import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Download, File, RefreshCw } from "lucide-react";
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Image } from "@/components/ai-elements/image";
import { RichMarkdown } from "@/components/RichMarkdown";
import type { PreviewRequest } from "@/app/useWorkbench";
import type { ApiClient } from "@/lib/api";
import { baseName } from "@/lib/format";
import { type PreviewKind, previewKindOf } from "@/lib/preview";
import type { FileContent, FileEntry, FileListing } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FileAccessProvider, useFilePicture } from "./fileAccess";

/** Up to this many entries, the tree opens fully — collapsing would hide everything. */
const EXPAND_ALL_MAX = 8;

const LANGUAGES: Record<string, BundledLanguage> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  css: "css",
  html: "html",
  md: "md",
  mdx: "md",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  py: "py",
  rs: "rs",
  go: "go",
  java: "java",
  sql: "sql",
  xml: "xml",
  svg: "xml",
};

/** Shiki's plain-text grammar; not part of the bundled-language union. */
const PLAIN = "text" as BundledLanguage;

function languageOf(path: string): BundledLanguage {
  const dot = path.lastIndexOf(".");
  return (dot < 0 ? undefined : LANGUAGES[path.slice(dot + 1).toLowerCase()]) ?? PLAIN;
}

interface TreeNode extends FileEntry {
  name: string;
  children: TreeNode[];
}

/**
 * The server's sorted flat list → a tree. A directory always precedes its own
 * entries in that order, so one pass is enough.
 */
export function buildTree(entries: readonly FileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const node: TreeNode = { ...entry, name: entry.path.slice(slash + 1), children: [] };
    if (entry.kind === "dir") dirs.set(entry.path, node);
    const parent = slash < 0 ? undefined : dirs.get(entry.path.slice(0, slash));
    (parent?.children ?? roots).push(node);
  }
  return roots;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `docs/a.md` → `docs`; a file at the root has none. */
const dirName = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

type ViewMode = "preview" | "source";
const VIEW_MODE_KEY = "vgent.files.viewMode";

/** 预览 or 源码 for the kinds that have both, remembered per kind the way an editor remembers it. */
function useViewMode(kind: PreviewKind | undefined): [ViewMode, (mode: ViewMode) => void] {
  const [modes, setModes] = useState<Partial<Record<PreviewKind, ViewMode>>>(() => {
    try {
      return JSON.parse(localStorage.getItem(VIEW_MODE_KEY) ?? "{}") as Partial<Record<PreviewKind, ViewMode>>;
    } catch {
      return {};
    }
  });
  const set = (mode: ViewMode): void => {
    if (kind == null) return;
    const next = { ...modes, [kind]: mode };
    setModes(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, JSON.stringify(next));
    } catch {
      // A full or disabled store only costs the memory of the choice.
    }
  };
  return [(kind != null ? modes[kind] : undefined) ?? "preview", set];
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-xl flex-none items-center gap-3xs rounded-sm border border-border px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
    >
      <ArrowLeft className="size-md" />
      返回
    </button>
  );
}

function ViewModeTabs({ mode, onMode }: { mode: ViewMode; onMode: (mode: ViewMode) => void }) {
  return (
    <div role="tablist" className="flex flex-none items-center rounded-sm border border-border p-px text-xs">
      {(["preview", "source"] as const).map((entry) => (
        <button
          key={entry}
          role="tab"
          type="button"
          aria-selected={mode === entry}
          onClick={() => onMode(entry)}
          className={cn("h-lg rounded-xs px-xs text-fg-muted hover:text-fg", mode === entry && "bg-bg-active text-fg")}
        >
          {entry === "preview" ? "预览" : "源码"}
        </button>
      ))}
    </div>
  );
}

/** The file as a picture, on a ground that shows a transparent one for what it is. */
function Picture({ path }: { path: string }) {
  const picture = useFilePicture(path);
  if (picture.status === "loading") return <p className="text-fg-faint text-xs">加载中…</p>;
  if (picture.status === "unavailable") return <p className="text-fg-faint text-xs">无法显示这张图片</p>;
  return (
    <div className="grid place-items-center rounded-lg bg-bg-inset p-sm">
      <Image {...picture.picture} uint8Array={new Uint8Array()} alt={baseName(path)} className="max-h-[70vh] w-auto rounded-none object-contain" />
    </div>
  );
}

/** One row, plus its children when it is an open directory. */
function Rows({
  nodes,
  expanded,
  onToggle,
  onOpen,
}: {
  nodes: TreeNode[];
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const open = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              title={node.path}
              {...(node.kind === "dir" ? { "aria-expanded": open } : {})}
              onClick={() => (node.kind === "dir" ? onToggle(node.path) : onOpen(node.path))}
              className="flex h-row-file w-full items-center gap-2xs rounded-sm px-2xs text-left hover:bg-bg-hover"
            >
              {node.kind === "dir" ? (
                open ? (
                  <ChevronDown className="size-md flex-none text-fg-faint" />
                ) : (
                  <ChevronRight className="size-md flex-none text-fg-faint" />
                )
              ) : (
                <File className="size-md flex-none text-fg-faint" />
              )}
              <span className={cn("min-w-0 flex-1 truncate font-mono text-code", node.kind === "dir" ? "text-fg" : "text-fg-muted")}>
                {node.name}
              </span>
            </button>
            {node.kind === "dir" && open && node.children.length > 0 && (
              <div className="pl-sm">
                <Rows nodes={node.children} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 文件 tab: the task's working tree, read-only.
 *
 * The server decides which directory that is — the task's own worktree, or the
 * project — exactly as it does for 变更. Selecting a file swaps the tree for
 * its content; there is no editing here.
 */
export function FilesPanel({
  client,
  threadId,
  active,
  refreshKey,
  preview,
  onPreviewTaken,
}: {
  client: ApiClient;
  threadId: string | null;
  /** The pane being open on this tab; a collapsed pane must not poll. */
  active: boolean;
  /** The thread's `updatedAt`: a new one means the engine wrote to disk. */
  refreshKey: string;
  /** A file the log asked to see, as the log wrote it; `onPreviewTaken` says it has been opened. */
  preview?: PreviewRequest | null;
  onPreviewTaken?: () => void;
}) {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  /** Where the last 下载 of the open file landed. */
  const [saved, setSaved] = useState<string | null>(null);
  /** Why a file the log asked for is not open. It sits above the tree and goes with the next file opened. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped per load; a stale response never writes state. */
  const generation = useRef(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const mine = ++generation.current;
    if (threadId == null) setListing(null);
    if (!active || threadId == null) return;
    setLoading(true);
    client
      .listFiles(threadId)
      .then((next) => {
        if (mine !== generation.current) return;
        setListing(next);
        setError(null);
        // Everything open when there is little to show, all closed otherwise.
        setExpanded(
          next.entries.length <= EXPAND_ALL_MAX
            ? new Set(next.entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path))
            : new Set(),
        );
      })
      .catch((failure: unknown) => {
        if (mine !== generation.current) return;
        setListing(null);
        setError(message(failure));
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
  }, [active, client, threadId, refreshKey, reload]);

  // A thread switch invalidates the open file, not just the listing.
  useEffect(() => {
    setSelected(null);
    setFilter("");
    setNotice(null);
  }, [threadId]);

  useEffect(() => {
    if (selected != null) setNotice(null);
    setSaved(null);
  }, [selected]);

  // The log asked for a file, in its own words — an absolute path as often as
  // not. The server says which of this task's files that is.
  useEffect(() => {
    if (preview == null || threadId == null) return;
    let cancelled = false;
    client.resolveFiles(threadId, [preview.path]).then(
      (found) => {
        if (cancelled) return;
        onPreviewTaken?.();
        const path = found[0]?.path;
        setNotice(path == null ? `文件不在任务目录里，或已经不在了：${preview.path}` : null);
        if (path != null) setSelected(path);
      },
      (failure: unknown) => {
        if (cancelled) return;
        onPreviewTaken?.();
        setNotice(message(failure));
      },
    );
    return () => {
      cancelled = true;
    };
    // `nonce` is the request; the rest are stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.nonce]);

  const kind = selected == null ? undefined : previewKindOf(selected);
  const [viewMode, setViewMode] = useViewMode(kind);
  const contentGeneration = useRef(0);

  useEffect(() => {
    const mine = ++contentGeneration.current;
    // A picture is fetched as bytes by whatever draws it; there is no text to ask for.
    if (threadId == null || selected == null || kind === "image") {
      setContent(null);
      setContentError(null);
      return;
    }
    client
      .getFileContent(threadId, selected)
      .then((next) => {
        if (mine !== contentGeneration.current) return;
        setContent(next);
        setContentError(null);
      })
      .catch((failure: unknown) => {
        if (mine !== contentGeneration.current) return;
        setContent(null);
        setContentError(message(failure));
      });
  }, [client, threadId, selected, kind, refreshKey]);

  const entries = listing?.entries ?? [];
  const needle = filter.trim().toLowerCase();
  // Filtering flattens: a match whose parent directory does not match has no
  // tree to sit in, so the hit list carries whole paths and files only.
  const matches = useMemo(
    () => (needle === "" ? [] : entries.filter((entry) => entry.kind === "file" && entry.path.toLowerCase().includes(needle))),
    [entries, needle],
  );
  const tree = useMemo(() => (needle === "" ? buildTree(entries) : []), [entries, needle]);

  const toggle = (path: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  if (selected != null) {
    return (
      <>
        <div className="mb-xs flex items-center gap-2xs">
          <BackButton onClick={() => setSelected(null)} />
          <span className="min-w-0 flex-1 truncate font-mono text-code text-fg-faint" title={selected}>
            {baseName(selected)}
          </span>
          {(kind === "svg" || kind === "markdown") && <ViewModeTabs mode={viewMode} onMode={setViewMode} />}
          <button
            type="button"
            aria-label="下载"
            title="下载"
            onClick={() => {
              if (threadId == null) return;
              client.downloadFile(threadId, { path: selected }).then(
                ({ savedTo }) => setSaved(`已保存到 ${savedTo}`),
                (failure: unknown) => setSaved(message(failure)),
              );
            }}
            className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg"
          >
            <Download className="size-md" />
          </button>
        </div>
        {saved != null && <p className="mb-xs break-all text-fg-muted text-xs">{saved}</p>}

        {/* The previews below read this task's files the same way a reply's pictures do. */}
        <FileAccessProvider
          value={threadId == null ? null : { client, threadId, refreshKey, openFile: setSelected, baseDir: dirName(selected) }}
        >
          {kind === "image" || (kind === "svg" && viewMode === "preview") ? (
            <Picture path={selected} />
          ) : contentError != null ? (
            <p className="text-danger text-xs">{contentError}</p>
          ) : content == null ? (
            <p className="text-fg-faint text-xs">加载中…</p>
          ) : content.binary ? (
            <p className="text-fg-faint text-xs">二进制文件</p>
          ) : kind === "markdown" && viewMode === "preview" ? (
            <RichMarkdown className="text-md leading-chat">{content.content}</RichMarkdown>
          ) : (
            <>
              <CodeBlock code={content.content} language={languageOf(selected)} showLineNumbers />
              {content.truncated && <p className="pt-2xs text-2xs text-fg-faint">文件过长，已截断</p>}
            </>
          )}
        </FileAccessProvider>
      </>
    );
  }

  return (
    <>
      <div className="mb-xs flex items-center gap-2xs">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="过滤文件"
          className="h-xl min-w-0 flex-1 rounded-sm border border-border bg-bg px-xs text-xs outline-none placeholder:text-fg-faint focus:border-border-strong"
        />
        <button
          type="button"
          aria-label="刷新"
          onClick={() => setReload((value) => value + 1)}
          className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg"
        >
          <RefreshCw className={cn("size-md", loading && "animate-spin")} />
        </button>
      </div>

      {notice != null && <p className="mb-xs text-danger text-xs">{notice}</p>}
      {error != null ? (
        <p className="text-danger text-xs">{error}</p>
      ) : threadId == null ? (
        <p className="text-fg-faint text-xs">先选一个任务</p>
      ) : entries.length === 0 ? (
        <p className="text-fg-faint text-xs">{loading ? "加载中…" : "没有可显示的文件"}</p>
      ) : needle !== "" ? (
        <>
          {matches.length === 0 ? (
            <p className="text-fg-faint text-xs">没有匹配的文件</p>
          ) : (
            matches.map((entry) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                onClick={() => setSelected(entry.path)}
                className="flex h-row-file w-full items-center gap-2xs rounded-sm px-2xs text-left hover:bg-bg-hover"
              >
                <File className="size-md flex-none text-fg-faint" />
                <span className="min-w-0 flex-1 truncate font-mono text-code text-fg-muted">{entry.path}</span>
              </button>
            ))
          )}
        </>
      ) : (
        <Rows nodes={tree} expanded={expanded} onToggle={toggle} onOpen={setSelected} />
      )}

      {listing?.truncated === true && <p className="mt-md text-2xs text-fg-faint">文件太多，列表已截断。</p>}
    </>
  );
}
