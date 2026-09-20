import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { ResizeHandle } from "@/components/ResizeHandle";
import { TopStrip } from "@/components/TopStrip";
import { CommandPalette, type Command } from "@/features/cmdk/CommandPalette";
import { EmptyState } from "@/features/empty/EmptyState";
import { RightPane } from "@/features/rightpane/RightPane";
import { NO_PROJECT_NAME, isNoProject } from "@/lib/noProject";
import { SettingsView } from "@/features/settings/SettingsView";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { GROUPING_LABELS } from "@/features/sidebar/grouping";
import type { QueueItem } from "@/features/worklog/queue";
import { oneLine } from "@/lib/format";
import { type PaneKey, type PaneWidths, clampPaneWidth, fitPaneWidths, loadPaneWidths, savePaneWidths } from "@/lib/paneWidths";
import { usePrefs, usePrefsSync } from "@/lib/prefs";
import { ThreadView } from "./ThreadView";
import { isLiveThread, useWorkbench } from "./useWorkbench";

/** The three-column grid. Widths come from the spacing tokens until a column is dragged to one of its own. */
export function Shell({ token }: { token: string }) {
  const workbench = useWorkbench(token);
  const {
    state,
    client,
    engines,
    thread,
    changes,
    selectedThreadId,
    activeProjectId,
    view,
    left,
    right,
    palette,
    grouping,
    settingsOpen,
    actions,
  } = workbench;
  const { toggleTheme, toggleDensity } = usePrefs();
  // 主题和密度存在 server 上：桌面 app 每次启动换端口，浏览器本地存储等于清空。
  usePrefsSync(
    state.settings,
    useCallback((prefs) => void client.putSettings(prefs).catch(() => undefined), [client]),
  );
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);

  const onQueue = useCallback((next: QueueItem[]) => setQueue(next), []);
  const onMessages = useCallback((next: UIMessage[]) => setMessages(next), []);

  const commands = useMemo<Command[]>(
    () => [
      { id: "new", label: "新任务", hint: "⌘N", run: actions.newTask },
      ...state.threads.map((entry) => ({
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
      // Only an engine whose history we own can be compacted, and only between turns.
      ...(thread != null &&
      engines.find((entry) => entry.id === thread.engine)?.capabilities.compact === true &&
      !isLiveThread(thread)
        ? [{ id: "compact", label: "压缩上下文", hint: "/compact", run: () => void actions.compactThread(thread.id) }]
        : []),
    ],
    [actions, engines, left, right.open, state.threads, thread, toggleDensity, toggleTheme],
  );

  // The right pane belongs to a task: without one open there is nothing for it to list.
  const showRight = right.open && !settingsOpen && view === "thread" && thread != null;

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
  const fitted = fitPaneWidths(widths, windowWidth, { left: left !== "off", right: showRight ? rightKey : null });
  const leftTrack = fitted.left != null ? `${fitted.left}px` : "var(--spacing-sidebar)";
  const rightTrack =
    fitted[rightKey] != null ? `${fitted[rightKey]}px` : right.tab === "home" ? "var(--spacing-rightlist)" : "var(--spacing-rightpane)";

  return (
    // No window bar of its own: like Cursor's Agents Window the three columns
    // run the full height, and each column's top strip is the title bar.
    <div className="h-full overflow-hidden">
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
          projects={state.projects}
          projectId={activeProjectId}
          threads={state.threads}
          grouping={grouping}
          onGrouping={actions.setGrouping}
          selectedThreadId={selectedThreadId}
          connected={state.connected}
          onSelect={actions.selectThread}
          onNewTask={actions.newTask}
          onOpenPalette={actions.openPalette}
          onOpenSettings={actions.openSettings}
          onToggle={actions.toggleLeft}
          onSelectProject={actions.selectProject}
          onAddProject={actions.addProject}
          onPickFolder={actions.pickFolder}
          settingsOpen={settingsOpen}
          getChat={actions.getChat}
          onArchive={actions.archiveThread}
          onUnread={actions.markUnread}
          onDelete={actions.deleteThread}
          onRename={actions.rename}
        />

        <main className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          {settingsOpen ? (
            <div className="row-span-3 flex min-h-0 flex-col">
              <TopStrip leftOpen={left === "on"} onToggleLeft={actions.toggleLeft} />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SettingsView settings={state.settings} engines={engines} client={client} onClose={actions.closeSettings} />
              </div>
            </div>
          ) : view === "thread" && thread != null ? (
            <ThreadView
              thread={thread}
              actions={actions}
              client={client}
              changes={changes}
              rightOpen={right.open}
              leftOpen={left === "on"}
              engines={engines}
              runMode={state.settings?.runMode}
              modelEngines={state.settings?.modelEngines}
              allowlist={state.settings?.allowlist}
              onQueue={onQueue}
              onMessages={onMessages}
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
                onRememberEngine={actions.rememberModelEngine}
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
            onClose={actions.toggleRight}
            changes={changes}
            client={client}
            threadId={selectedThreadId}
            refreshKey={thread?.updatedAt ?? ""}
            preview={right.preview}
            onPreviewTaken={actions.clearPreview}
            messages={messages}
            thread={thread}
            place={isNoProject(thread?.projectId) ? NO_PROJECT_NAME : state.projects.find((entry) => entry.id === thread?.projectId)?.name}
            live={isLiveThread(thread)}
            onBuild={actions.buildFromPlan}
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

      {palette && <CommandPalette commands={commands} onClose={actions.closePalette} />}
    </div>
  );
}
