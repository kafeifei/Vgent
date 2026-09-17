import { useCallback, useMemo, useState } from "react";
import { CommandPalette, type Command } from "@/features/cmdk/CommandPalette";
import { EmptyState } from "@/features/empty/EmptyState";
import { RightPane } from "@/features/rightpane/RightPane";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { GROUPING_LABELS } from "@/features/sidebar/grouping";
import type { QueueItem } from "@/features/worklog/queue";
import { oneLine } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { ThreadView } from "./ThreadView";
import { TitleBar } from "./TitleBar";
import { useWorkbench } from "./useWorkbench";

/** The three-column grid. Widths come straight from the spacing tokens. */
export function Shell({ token }: { token: string }) {
  const workbench = useWorkbench(token);
  const { state, client, thread, selectedThreadId, activeProjectId, view, left, right, palette, grouping, actions } =
    workbench;
  const { toggleTheme, toggleDensity } = usePrefs();
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const onQueue = useCallback((next: QueueItem[]) => setQueue(next), []);

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
    ],
    [actions, left, right.open, state.threads, toggleDensity, toggleTheme],
  );

  return (
    <div className="grid h-full grid-rows-[var(--spacing-topbar)_minmax(0,1fr)] overflow-hidden">
      <TitleBar
        projects={state.projects}
        projectId={activeProjectId}
        onSelectProject={actions.selectProject}
        onAddProject={actions.addProject}
        onPickFolder={actions.pickFolder}
        onOpenPalette={actions.openPalette}
        connected={state.connected}
      />

      <div
        className="grid min-h-0 transition-[grid-template-columns] duration-[var(--duration-base)]"
        style={{
          gridTemplateColumns: `${left === "rail" ? "var(--spacing-sidebar-rail)" : "var(--spacing-sidebar)"} minmax(0,1fr) ${
            right.open ? "var(--spacing-rightpane)" : "0px"
          }`,
        }}
      >
        <Sidebar
          projects={state.projects}
          threads={state.threads}
          grouping={grouping}
          onGrouping={actions.setGrouping}
          selectedThreadId={selectedThreadId}
          rail={left === "rail"}
          onSelect={actions.selectThread}
          onNewTask={actions.newTask}
          getChat={actions.getChat}
        />

        <main className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          {view === "thread" && thread != null ? (
            <ThreadView thread={thread} actions={actions} rightOpen={right.open} onQueue={onQueue} />
          ) : (
            <div className="row-span-3 min-h-0 overflow-y-auto">
              <EmptyState
                projects={state.projects}
                projectId={activeProjectId}
                settings={state.settings}
                onSelectProject={actions.selectProject}
                onAddProject={actions.addProject}
                onPickFolder={actions.pickFolder}
                onStart={actions.startThread}
              />
            </div>
          )}
        </main>

        <RightPane
          queue={queue}
          open={right.open}
          tab={right.tab}
          onTab={actions.setRightTab}
          onClose={actions.toggleRight}
          client={client}
          projectId={activeProjectId}
          file={right.file}
          onSelectFile={actions.selectChange}
          refreshKey={thread?.updatedAt ?? ""}
          toast={actions.toast}
        />
      </div>

      {palette && <CommandPalette commands={commands} onClose={actions.closePalette} />}
    </div>
  );
}
