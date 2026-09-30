import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { X, RotateCcw, Play, PanelLeft, Sun, Moon, Monitor, Search } from "lucide-react";
import { ThreadView, type ThreadViewActions } from "@/app/ThreadView";
import { isLiveThread, type InspectRequest, type PreviewRequest } from "@/app/useWorkbench";
import { ModelCatalogClientContext } from "@/components/ModelPicker";
import { ResizeHandle } from "@/components/ResizeHandle";
import { useChanges } from "@/features/changes/useChanges";
import { FileAccessProvider } from "@/features/files/fileAccess";
import { FilePictureDialog } from "@/features/files/TaskPicture";
import { RightPane, type RightTab } from "@/features/rightpane/RightPane";
import { RightPaneToggle } from "@/features/taskheader/TaskHeader";
import type { QueueItem } from "@/features/worklog/queue";
import { hasTrafficLights } from "@/lib/host";
import { usePrefs } from "@/lib/prefs";
import { previewKindOf } from "@/lib/preview";
import { useToast } from "@/lib/toast";
import { ENGINES, SCENARIOS, type ChatScenario } from "./fixtures";
import { StyleSession } from "./runtime";

const button = "inline-flex shrink-0 items-center justify-center gap-xs rounded-md px-sm py-xs text-xs text-fg-muted hover:bg-bg-hover hover:text-fg focus-visible:outline focus-visible:outline-focus-ring";
const groups = [...new Set(SCENARIOS.map((scene) => scene.group))];

export default function ChatStyleLab({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState(SCENARIOS[0]!);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("");
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(false);
  const [width, setWidth] = useState("full");
  const { theme, density, toggleTheme, toggleDensity } = usePrefs();
  const toast = useToast();
  const [session, setSession] = useState<StyleSession | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const reset = useCallback(() => { setRight(selected.tab != null); setRevision((value) => value + 1); }, [selected]);
  useEffect(() => {
    const instance = new StyleSession(selected, toast);
    setSession(instance);
    return () => instance.dispose();
  }, [selected, revision, toast]);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const visible = SCENARIOS.filter((scene) => `${scene.label} ${scene.group} ${scene.hint}`.toLowerCase().includes(filter.toLowerCase()));
  const choose = (scene: ChatScenario) => { setRight(scene.tab != null); setSelected(scene); setRevision((value) => value + 1); };
  return (
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="聊天样式" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-bg outline-none"
      onKeyDownCapture={(event) => {
        // Keep workbench shortcuts inside the preview, including events from its portals.
        if ((event.metaKey || event.ctrlKey) && ["n", "j", "b", "k", ","].includes(event.key.toLowerCase())) {
          event.preventDefault(); event.stopPropagation();
          if (event.key.toLowerCase() === "j") setRight((value) => !value);
          if (event.key.toLowerCase() === "k") root.current?.querySelector<HTMLInputElement>('input[aria-label="搜索聊天场景"]')?.focus();
          if (event.key.toLowerCase() === "b") setLeft((value) => !value);
          if (event.key.toLowerCase() === "n") choose(SCENARIOS.find((scene) => scene.id === "empty")!);
        }
      }}>
      <header data-tauri-drag-region="deep" className={`flex min-h-topbar shrink-0 flex-wrap items-center gap-xs border-b border-border px-sm py-xs ${hasTrafficLights() ? "pl-traffic" : ""}`}>
        <button className={button} title="显示或隐藏场景" aria-label="显示或隐藏场景" aria-pressed={left} onClick={() => setLeft(!left)}><PanelLeft className="size-sm" /></button>
        <strong className="mr-xs text-sm font-medium">聊天样式</strong>
        <span className="mr-auto text-xs text-fg-faint">样例数据 · 真实组件</span>
        <select aria-label="选择聊天场景" className="max-w-44 rounded-md bg-bg-elevated px-xs py-xs text-xs" value={selected.id} onChange={(event) => choose(SCENARIOS.find((scene) => scene.id === event.target.value)!)}>
          {groups.map((group) => <optgroup label={group} key={group}>{SCENARIOS.filter((scene) => scene.group === group).map((scene) => <option value={scene.id} key={scene.id}>{scene.label}</option>)}</optgroup>)}
        </select>
        <button className={button} onClick={reset} title="重置当前样例"><RotateCcw className="size-sm" />重置</button>
        <button className={button} onClick={() => void session?.replay()}><Play className="size-sm" />演示回复</button>
        <select aria-label="预览宽度" className="rounded-md bg-bg-elevated px-xs py-xs text-xs" value={width} onChange={(event) => setWidth(event.target.value)}>
          <option value="full">填满窗口</option><option value="1280">1280 px</option><option value="1024">1024 px</option><option value="768">768 px</option>
        </select>
        <button className={button} onClick={toggleTheme} title="切换应用主题">{theme === "system" ? <Monitor className="size-sm" /> : theme === "dark" ? <Moon className="size-sm" /> : <Sun className="size-sm" />}{theme === "system" ? "跟随系统" : theme === "dark" ? "深色" : "浅色"}</button>
        <button className={button} onClick={toggleDensity} title="切换应用密度">{density === "compact" ? "紧凑" : "舒适"}</button>
        <button className={button} onClick={onClose} aria-label="关闭聊天样式" title="返回工作台"><X className="size-md" /></button>
      </header>
      <div className="flex min-h-0 flex-1">
        {left && <nav aria-label="聊天场景" className="flex w-56 shrink-0 flex-col border-r border-border bg-bg-elevated max-[900px]:w-44">
          <div className="flex items-center gap-xs px-sm py-sm text-fg-faint"><Search className="size-sm shrink-0" /><input aria-label="搜索聊天场景" placeholder={`搜索 ${SCENARIOS.length} 个场景`} value={filter} onChange={(event) => setFilter(event.target.value)} className="w-full min-w-0 bg-transparent text-xs outline-none" /></div>
          <div className="min-h-0 flex-1 overflow-y-auto px-xs pb-md">
            {groups.map((group) => {
              const items = visible.filter((scene) => scene.group === group);
              return items.length === 0 ? null : <section key={group} className="mb-md"><h2 className="px-sm py-xs text-xs font-medium text-fg-faint">{group}</h2>{items.map((scene) => <button key={scene.id} aria-current={scene.id === selected.id ? "page" : undefined} onClick={() => choose(scene)} className={`block w-full rounded-md px-sm py-xs text-left text-sm ${scene.id === selected.id ? "bg-bg-active text-fg" : "text-fg-muted hover:bg-bg-hover"}`}>{scene.label}</button>)}</section>;
            })}
            {visible.length === 0 && <p className="p-sm text-xs text-fg-faint">没有匹配的场景。</p>}
          </div>
          <p className="border-t border-border px-sm py-sm text-xs leading-relaxed text-fg-faint">{selected.hint}</p>
        </nav>}
        <div className="flex min-w-0 flex-1 justify-center overflow-hidden bg-bg-hover">
          <div className="flex min-h-0 w-full flex-col bg-bg" style={{ maxWidth: width === "full" ? undefined : Number(width) }}>
            {session?.scenario === selected && <Scene key={session.chat.id} session={session} right={right} setRight={setRight} left={left} toggleLeft={() => setLeft((value) => !value)} onReset={reset} onEmpty={() => choose(SCENARIOS.find((scene) => scene.id === "empty")!)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Scene({ session, right, setRight, left, toggleLeft, onReset, onEmpty }: { right: boolean; setRight: (value: boolean) => void; session: StyleSession; left: boolean; toggleLeft: () => void; onReset: () => void; onEmpty: () => void }) {
  const thread = useSyncExternalStore(session.subscribe, session.snapshot);
  const { client, scenario } = session;
  const toast = useToast();
  const [tab, setTab] = useState<RightTab>(scenario.tab ?? "home");
  const [file, setFile] = useState<string | null>(scenario.file ?? null);
  const [preview, setPreview] = useState<PreviewRequest | null>(null);
  const [inspect, setInspect] = useState<InspectRequest | null>(scenario.inspect ? { toolCallId: scenario.inspect, nonce: 0 } : null);
  const [summary, setSummary] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>(session.chat.messages);
  const [paneWidth, setPaneWidth] = useState(360);
  const [allowlist, setAllowlist] = useState<readonly string[]>([]);
  const changes = useChanges({ client, threadId: thread.id, refreshKey: thread.updatedAt, selected: file, onSelect: setFile, toast });
  const actions = useMemo<ThreadViewActions>(() => ({
    whenReady: async () => {}, getChat: () => session.chat, focusChat: () => {}, toast,
    allowTools: (entries) => setAllowlist((list) => [...list, ...entries]),
    openPreview: (path) => { setPreview({ path, nonce: Date.now() }); setTab("files"); setRight(true); },
    openChanges: (path) => { setFile(path ?? null); setTab("changes"); setRight(true); },
    focusTerminal: (toolCallId) => { setInspect({ toolCallId, nonce: Date.now() }); setTab("term"); setRight(true); },
    inspectTool: (toolCallId) => { setInspect({ toolCallId, nonce: Date.now() }); setTab("tool"); setRight(true); },
    openSummary: (messageId) => { setSummary(messageId); setTab("summary"); setRight(true); },
    forkThread: (_id, messageId) => {
      const index = session.chat.messages.findIndex((message) => message.id === messageId);
      session.chat.messages = session.chat.messages.slice(0, index + 1);
      session.patch({ title: "样例分叉", status: "idle", forkedFrom: { threadId: "style-origin", messageId } });
      toast("已在当前样例演示分叉，重置可恢复。");
    },
    setRightTab: setTab, openRight: () => setRight(true), toggleLeft,
    compactThread: session.compact, newTask: onEmpty,
    queueMessage: (_id, text, mode, files) => session.queue(text, mode, files),
    send: (_id, text, files) => session.send(text, files), stop: () => { void session.stop(); },
    rememberModelPick: () => {},
    setModel: (_id, engine, model) => session.patch({ engine, model }),
    setReasoningEffort: (_id, value) => session.patch({ reasoningEffort: value ?? undefined }),
    setContextWindow: (_id, value) => session.patch({ contextWindow: value ?? undefined }),
    setServiceTier: (_id, value) => session.patch({ serviceTier: value ?? undefined }),
    setMode: (_id, mode) => session.patch({ mode }),
    sendQueued: (_id, itemId) => session.sendQueued(itemId),
    editQueued: (_id, itemId, text) => session.patch({ queue: session.snapshot().queue?.map((item) => item.id === itemId ? { ...item, text } : item) }),
    deleteQueued: (_id, itemId) => session.deleteQueued(itemId),
    reorderQueue: (_id, ids) => session.patch({ queue: ids.flatMap((id) => session.snapshot().queue?.filter((item) => item.id === id) ?? []) }),
    steerQueued: (_id, itemId) => {
      const item = session.snapshot().queue?.find((entry) => entry.id === itemId);
      if (!item || item.files?.length) return;
      session.chat.messages = [...session.chat.messages, { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "data-steer", data: { text: item.text } }] }];
      session.patch({ queue: session.snapshot().queue?.filter((entry) => entry.id !== itemId) });
    },
    reclaimWorkspace: async () => { const workspace = session.snapshot().workspace; if (workspace) session.patch({ workspace: { ...workspace, reclaimed: true } }); },
    restoreWorkspace: async () => { const workspace = session.snapshot().workspace; if (workspace) session.patch({ workspace: { ...workspace, reclaimed: false } }); },
    archiveThread: (_id, archived) => session.patch({ archivedAt: archived ? new Date().toISOString() : undefined }),
    countUncommitted: async () => 0,
  }), [session, toast, toggleLeft, onEmpty, setRight]);
  const openFile = useCallback((path: string) => {
    const kind = previewKindOf(path);
    if (kind === "image" || kind === "svg") setPicture(path);
    else actions.openPreview(path);
  }, [actions]);
  // Used for picture dialogs too; all file operations remain on the local adapter.
  const fileAccess = useMemo(() => ({ client, threadId: thread.id, refreshKey: thread.updatedAt, openFile, notify: toast }), [client, thread.id, thread.updatedAt, openFile, toast]);
  const grid = useRef<HTMLDivElement>(null);
  return <ModelCatalogClientContext value={client}>
    <div ref={grid} className="relative grid min-h-0 flex-1" style={{ gridTemplateColumns: `minmax(0,1fr) ${right ? `min(${paneWidth}px, 48%)` : "0px"}` }}>
      <main className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto]">
        <ThreadView thread={thread} failedFirstSend={false} actions={actions} client={client} changes={changes} rightOpen={right} leftOpen={left} engines={ENGINES} runMode="allow-reads" modelPicks={{}} allowlist={allowlist} onQueue={setQueue} onMessages={setMessages} onOpenPicture={setPicture} />
      </main>
      {right && <RightPane queue={queue} open tab={tab} onTab={setTab} changes={changes} client={client} threadId={thread.id} refreshKey={thread.updatedAt} preview={preview} onPreviewTaken={() => setPreview(null)} inspect={inspect} summary={summary} messages={messages} thread={thread} place="样例项目" live={isLiveThread(thread)} onBuild={async (_id, content) => { session.patch({ mode: "agent" }); await session.send(content); }} onOpenPicture={setPicture} onOpenFile={openFile} />}
      <div className="pointer-events-none absolute top-0 right-0 z-10 flex h-topbar items-center pr-sm"><RightPaneToggle open={right} pending={queue.length} onToggle={() => setRight(!right)} className="pointer-events-auto" /></div>
      {right && <ResizeHandle side="right" offset={`min(${paneWidth}px, 48%)`} onStart={() => Math.min(paneWidth, (grid.current?.clientWidth ?? 1000) * .48)} onDrag={(width) => setPaneWidth(Math.max(220, Math.min(width, (grid.current?.clientWidth ?? 1000) * .48)))} onEnd={() => {}} onReset={() => setPaneWidth(360)} />}
      {picture && <FileAccessProvider value={fileAccess}><FilePictureDialog path={picture} onClose={() => setPicture(null)} /></FileAccessProvider>}
    </div>
    <footer className="flex shrink-0 items-center gap-xs border-t border-border px-sm py-2xs text-xs text-fg-faint"><span className="min-w-0 flex-1 truncate" title={scenario.hint}>{scenario.label} · {scenario.hint}</span><button className="shrink-0 hover:text-fg" onClick={onReset}>恢复样例</button></footer>
  </ModelCatalogClientContext>;
}
