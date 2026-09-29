import { ModelCatalogClientContext } from "@/components/ModelPicker";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { X } from "lucide-react";
import { ResizeHandle } from "@/components/ResizeHandle";
import { TopStrip } from "@/components/TopStrip";
import { CommandPalette, type Command } from "@/features/cmdk/CommandPalette";
import { EmptyState } from "@/features/empty/EmptyState";
import { FileAccessProvider } from "@/features/files/fileAccess";
import { FilePictureDialog } from "@/features/files/TaskPicture";
import { RightPane } from "@/features/rightpane/RightPane";
import { NO_PROJECT_NAME, isNoProject } from "@/lib/noProject";
import { SettingsView, type SettingsTab } from "@/features/settings/SettingsView";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { GROUPING_LABELS } from "@/features/sidebar/grouping";
import type { QueueItem } from "@/features/worklog/queue";
import { oneLine } from "@/lib/format";
import { previewKindOf } from "@/lib/preview";
import { type PaneKey, type PaneWidths, PANE_DEFAULT, clampPaneWidth, fitPaneWidths, loadPaneWidths, savePaneWidths } from "@/lib/paneWidths";
import { usePrefs, usePrefsSync } from "@/lib/prefs";
import { RightPaneToggle } from "@/features/taskheader/TaskHeader";
import { ThreadView } from "./ThreadView";
import { isLiveThread, useWorkbench } from "./useWorkbench";

const ChatStyleLab = lazy(() => import("@/features/style-lab/ChatStyleLab"));

/** The three-column grid. Widths come from the spacing tokens until a column is dragged to one of its own. */
export function Shell({ token }: { token: string }) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const workbench = useWorkbench(token);
  const {
    state,
    client,
    engines,
    thread,
    visibleThreads,
    changes,
    selectedThreadId,
    activeProjectId,
    view,
    left,
    right,
    palette,
    grouping,
    settingsOpen,
    failedFirstSend,
    actions,
  } = workbench;
  const { density, toggleTheme, toggleDensity } = usePrefs();
  // 主题和密度存在 server 上：桌面 app 每次启动换端口，浏览器本地存储等于清空。
  usePrefsSync(
    state.settings,
    useCallback((prefs) => void client.putSettings(prefs).catch(() => undefined), [client]),
  );
  const [styleLabOpen, setStyleLabOpen] = useState(false);
  const openStyleLab = useCallback(() => { actions.closeSettings(); actions.closePalette(); setStyleLabOpen(true); }, [actions]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [picture, setPicture] = useState<{ threadId: string; path: string } | null>(null);
  const openPicture = useCallback((path: string) => {
    if (selectedThreadId != null) setPicture({ threadId: selectedThreadId, path });
  }, [selectedThreadId]);
  useEffect(() => setPicture(null), [selectedThreadId]);

  const onQueue = useCallback((next: QueueItem[]) => setQueue(next), []);
  const onMessages = useCallback((next: UIMessage[]) => setMessages(next), []);

  const commands = useMemo<Command[]>(
    () => [
      { id: "style-lab", label: "聊天样式 · 所有场景", run: openStyleLab },
      { id: "new", label: "新任务", hint: "⌘N", run: actions.newTask },
      ...visibleThreads.map((entry) => ({
        id: `thread-${entry.id}`,
        label: `切换到任务 ${oneLine(entry.title, 50)}`,
        run: () => actions.selectThread(entry.id),
      })),
      ...(["project", "status", "updated"] as const).map((entry) => ({
        id: `group-${entry}`,
        label: `切换分组方式 · ${GROUPING_LABELS[entry]}`,
        run: () => actions.setGrouping(entry),
      })),
      { id: "theme", label: "切换主题", run: toggleTheme },
      { id: "density", label: "切换密度", run: toggleDensity },
      { id: "left", label: left === "on" ? "收起侧栏" : "展开侧栏", hint: "⌘B", run: actions.toggleLeft },
      { id: "right", label: right.open ? "收起右栏" : "展开右栏", hint: "⌘J", run: actions.toggleRight },
      { id: "changes", label: "查看变更", run: () => actions.openChanges() },
      { id: "settings", label: "设置", hint: "⌘,", run: actions.openSettings },
      // Only an engine whose history we own can be compacted, only between turns, and not once archived.
      ...(thread != null &&
      engines.find((entry) => entry.id === thread.engine)?.capabilities.compact === true &&
      !isLiveThread(thread) &&
      thread.archivedAt == null
        ? [{ id: "compact", label: "压缩上下文", hint: "/compact", run: () => void actions.compactThread(thread.id) }]
        : []),
    ],
    [actions, openStyleLab, engines, left, right.open, visibleThreads, thread, toggleDensity, toggleTheme],
  );

  // The right pane belongs to a task: without one open there is nothing for it to list.
  const showRight = right.open && view === "thread" && thread != null;

  // Dragged column widths. The grid is the measure of what a column is *now*
  // — a token, until dragged — so a drag starts from the rendered track.
  const grid = useRef<HTMLDivElement | null>(null);
  const [widths, setWidths] = useState<PaneWidths>(loadPaneWidths);
  const [dragging, setDragging] = useState(false);
  const rightKey: PaneKey = right.tab === "home" ? "rightList" : "rightPane";
  const tracks = (): number[] =>
    grid.current == null ? [] : getComputedStyle(grid.current).gridTemplateColumns.split(" ").map((track) => Number.parseFloat(track) || 0);
  const resize = (key: PaneKey, wanted: number): void => {
    const [leftNow = 0, , rightNow = 0] = tracks();
    const width = clampPaneWidth(key, wanted, window.innerWidth, key === "left" ? rightNow : leftNow);
    setWidths((current) => (current[key] === width ? current : { ...current, [key]: width }));
  };
  const endResize = (): void => {
    setDragging(false);
    setWidths((current) => {
      savePaneWidths(current);
      return current;
    });
  };
  const resetWidth = (key: PaneKey): void =>
    setWidths((current) => {
      const { [key]: _dropped, ...rest } = current;
      savePaneWidths(rest);
      return rest;
    });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const paneDefaults = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (key: PaneKey, token: string) => Number.parseFloat(style.getPropertyValue(token)) || PANE_DEFAULT[key];
    return {
      left: read("left", "--spacing-sidebar"),
      rightList: read("rightList", "--spacing-rightlist"),
      rightPane: read("rightPane", "--spacing-rightpane"),
    };
  }, [density]);
  const fitted = fitPaneWidths(widths, windowWidth, { left: left !== "off", right: showRight ? rightKey : null }, paneDefaults);
  const leftTrack = fitted.left != null ? `${fitted.left}px` : "var(--spacing-sidebar)";
  const rightTrack =
    fitted[rightKey] != null ? `${fitted[rightKey]}px` : right.tab === "home" ? "var(--spacing-rightlist)" : "var(--spacing-rightpane)";

  return (
    // No window bar of its own: like Cursor's Agents Window the three columns
    // run the full height, and each column's top strip is the title bar.
    <ModelCatalogClientContext.Provider value={client}><div className="relative h-full overflow-hidden">
      <div inert={styleLabOpen || undefined} className="h-full">
      <div
        ref={grid}
        className={
          // The open/close slide would make a drag lag behind the pointer.
          dragging ? "relative grid h-full min-h-0" : "relative grid h-full min-h-0 transition-[grid-template-columns] duration-[var(--duration-base)]"
        }
        style={{
          gridTemplateColumns: `${left === "off" ? "0px" : leftTrack} minmax(0,1fr) ${!showRight ? "0px" : rightTrack}`,
        }}
      >
        <Sidebar
          client={client}
          onManageAccount={id => { setSettingsTab(id === "github" ? "remote" : "providers"); actions.openSettings(); }}
          projects={state.projects}
          projectId={activeProjectId}
          threads={visibleThreads}
          grouping={grouping}
          onGrouping={actions.setGrouping}
          selectedThreadId={selectedThreadId}
          connected={state.connected}
          onSelect={actions.selectThread}
          onNewTask={actions.newTask}
          onOpenPalette={actions.openPalette}
          onOpenSettings={() => { setSettingsTab("general"); actions.openSettings(); }}
          onToggle={actions.toggleLeft}
          onOpenProject={actions.openProject}
          onOpenFolder={actions.openFolder}
          onPickFolder={actions.pickFolder}
          settingsOpen={settingsOpen}
          onArchive={actions.archiveThread}
          onCheckUncommitted={actions.countUncommitted}
          onUnread={actions.markUnread}
          onDelete={actions.deleteThread}
          onRename={actions.rename}
        />

        <main className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto]">
          {view === "thread" && thread != null ? (
            <ThreadView
              thread={thread}
              failedFirstSend={failedFirstSend === thread.id}
              actions={actions}
              client={client}
              changes={changes}
              rightOpen={right.open}
              leftOpen={left === "on"}
              engines={engines}
              runMode={state.settings?.runMode}
              modelPicks={state.settings?.modelPicks}
              allowlist={state.settings?.allowlist}
              onQueue={onQueue}
              onMessages={onMessages}
              onOpenPicture={openPicture}
            />
          ) : (
            <div className="row-span-3 flex min-h-0 flex-col">
              <TopStrip leftOpen={left === "on"} onToggleLeft={actions.toggleLeft} />
              <div className="min-h-0 flex-1 overflow-y-auto">
              <EmptyState
                projects={state.projects}
                projectId={activeProjectId}
                engines={engines}
                settings={state.settings}
                client={client}
                onSelectProject={actions.selectProject}
                onAddProject={actions.addProject}
                onPickFolder={actions.pickFolder}
                onStart={actions.startThread}
                onRememberPick={actions.rememberModelPick}
              />
              </div>
            </div>
          )}
        </main>

        {showRight && (
          <RightPane
            queue={queue}
            open={right.open}
            tab={right.tab}
            onTab={actions.setRightTab}
            changes={changes}
            client={client}
            threadId={selectedThreadId}
            refreshKey={thread?.updatedAt ?? ""}
            preview={right.preview}
            onPreviewTaken={actions.clearPreview}
            inspect={right.inspect}
            messages={messages}
            thread={thread}
            place={isNoProject(thread?.projectId) ? NO_PROJECT_NAME : state.projects.find((entry) => entry.id === thread?.projectId)?.name}
            live={isLiveThread(thread)}
            onBuild={actions.buildFromPlan}
            onOpenPicture={openPicture}
            onOpenFile={(file) => {
              const kind = previewKindOf(file);
              if (kind === "image" || kind === "svg") openPicture(file);
              else if (kind === "markdown") actions.openPreview(file);
              else actions.openChanges(file);
            }}
          />
        )}

        {left !== "off" && (
          <ResizeHandle
            side="left"
            offset={leftTrack}
            onStart={() => {
              setDragging(true);
              return tracks()[0] ?? 0;
            }}
            onDrag={(width) => resize("left", width)}
            onEnd={endResize}
            onReset={() => resetWidth("left")}
          />
        )}
        {showRight && (
          <ResizeHandle
            side="right"
            offset={rightTrack}
            onStart={() => {
              setDragging(true);
              return tracks()[2] ?? 0;
            }}
            onDrag={(width) => resize(rightKey, width)}
            onEnd={endResize}
            onReset={() => resetWidth(rightKey)}
          />
        )}
      </div>

      {view === "thread" && thread != null && (
        // Pinned to the window, not to a column: opening the pane used to leave
        // this button on the conversation's right edge, short of the window's.
        <div className="pointer-events-none absolute top-0 right-0 z-10 flex h-topbar items-center pr-sm">
          <RightPaneToggle
            open={right.open}
            pending={thread.pendingApprovals + queue.filter((item) => item.kind === "question").length}
            onToggle={actions.toggleRight}
            className="pointer-events-auto"
          />
        </div>
      )}

      {palette && <CommandPalette commands={commands} onClose={actions.closePalette} />}
      {picture != null && picture.threadId === selectedThreadId && (
        <FileAccessProvider value={{ client, threadId: picture.threadId, refreshKey: thread?.updatedAt ?? "", openFile: openPicture, notify: actions.toast }}>
          <FilePictureDialog key={`${picture.threadId}:${picture.path}`} path={picture.path} onClose={() => setPicture(null)} />
        </FileAccessProvider>
      )}
      {settingsOpen && (
        // 设置 floats over the workbench like Cursor's: the columns stay put
        // underneath, dimmed and softly blurred, and come back untouched on close.
        <div
          role="presentation"
          className="fixed inset-0 z-20 flex items-center justify-center bg-bg-scrim p-2xl backdrop-blur-xs"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) actions.closeSettings();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="设置"
            className="relative flex h-full max-h-[calc(var(--spacing-3xl)*15)] w-full max-w-[calc(var(--spacing-log-max)+var(--spacing-3xl)*3)] min-h-0 flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-lg ring-1 ring-border-strong"
          >
            <button
              type="button"
              title="关闭"
              onClick={actions.closeSettings}
              className="absolute top-sm right-sm z-10 grid size-lg place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <X className="size-md" />
            </button>
            <div className="min-h-0 flex-1">
              <SettingsView initialTab={settingsTab} onOpenStyleLab={openStyleLab} settings={state.settings} engines={engines} client={client} onClose={actions.closeSettings} />
            </div>
          </div>
        </div>
      )}
      </div>
      {styleLabOpen && <Suspense fallback={<div className="absolute inset-0 z-30 grid place-items-center bg-bg">加载聊天样式…</div>}><ChatStyleLab onClose={() => setStyleLabOpen(false)} /></Suspense>}
    </div></ModelCatalogClientContext.Provider>
  );
}
