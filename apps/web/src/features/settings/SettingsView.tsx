import { useEffect, useState, type ReactNode } from "react";
import { Globe, Bot, GitBranch, Monitor, Palette, Pencil, Plug, Plus, Settings2, Trash2, Wrench } from "lucide-react";
import { ComputerUseSection } from "./ComputerUseSection";
import { RemotePage } from "./RemotePage";
import { RuntimesSection } from "./RuntimesSection";
import { ApiError, type ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, McpServerConfig, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AppearanceSection } from "./AppearanceSection";
import { EMPTY_MCP_FORM, fromForm, toForm, type McpForm } from "./mcpForm";
import { NotificationsSection } from "./NotificationsSection";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Segmented, SettingsEmpty, SettingsGroup, SettingsPage, SettingsRow, Tag } from "./layout";
import { ProvidersPage } from "./ProvidersPage";
import { INPUT_CLASS, PILL, TEXTAREA_CLASS } from "./styles";
import { isImeKeyEvent } from "@/lib/ime";

/** The pages of 设置, in the order of the left-hand list. */
export type SettingsTab = "general" | "appearance" | "agents" | "providers" | "mcp" | "computer" | "worktrees" | "remote";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: typeof Bot }> = [
  { id: "general", label: "通用", icon: Settings2 },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "providers", label: "模型提供商", icon: Plug },
  { id: "mcp", label: "工具与 MCP", icon: Wrench },
  { id: "computer", label: "Computer Use", icon: Monitor },
  { id: "remote", label: "远程控制", icon: Globe },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
];

const MCP_KINDS: ReadonlyArray<{ id: McpForm["kind"]; label: string }> = [
  { id: "stdio", label: "stdio" },
  { id: "http", label: "http" },
  { id: "sse", label: "sse" },
];

/** Deep-equal via a key-sorted `JSON.stringify`, so field order never causes a false "dirty". */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val != null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

/**
 * 主题, 密度 and the Computer Use switch are not part of this page's draft: they
 * apply and store on the click. Keeping them out of both the comparison and the
 * payload is what stops 保存 from writing back the values this page was *opened* with.
 */
function withoutAppearance(settings: Settings): Omit<Settings, "theme" | "density" | "computerUseProvider"> {
  const { theme: _theme, density: _density, computerUseProvider: _computerUse, ...rest } = settings;
  return rest;
}

const settingsKey = (settings: Settings): string => stableStringify(withoutAppearance(settings));

function describeServer(config: McpServerConfig): { kind: string; detail: string } {
  if ("command" in config) return { kind: "stdio", detail: [config.command, ...(config.args ?? [])].join(" ") };
  return { kind: config.transport === "sse" ? "sse" : "http", detail: config.url };
}

/** Name, type pills, and the fields for whichever type is picked. */
function McpFormPanel({
  form,
  error,
  pickerAvailable,
  onChange,
  onPickExecutable,
  onCancel,
  onSubmit,
}: {
  form: McpForm;
  error: string | null;
  pickerAvailable: boolean;
  onChange: (form: McpForm) => void;
  onPickExecutable: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const set = <K extends keyof McpForm>(key: K, value: McpForm[K]) => onChange({ ...form, [key]: value });

  return (
    <div className="flex flex-col gap-xs rounded-md border border-border bg-bg-elevated p-sm">
      <div className="flex flex-wrap gap-xs">
        <label className="flex min-w-0 flex-1 flex-col gap-2xs">
          <span className="text-fg-faint text-sm">名称</span>
          <input value={form.name} onChange={(event) => set("name", event.target.value)} className={INPUT_CLASS} />
        </label>
        <div className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-sm">类型</span>
          <Segmented label="类型" value={form.kind} options={MCP_KINDS} onChange={(kind) => set("kind", kind)} />
        </div>
      </div>

      {form.kind === "stdio" ? (
        <>
          <label className="flex flex-col gap-2xs">
            <span className="text-fg-faint text-sm">可执行文件</span>
            <div className="flex gap-2xs">
              <input
                value={form.command}
                onChange={(event) => set("command", event.target.value)}
                placeholder="/usr/local/bin/my-server"
                className={cn(INPUT_CLASS, "min-w-0 flex-1 font-mono")}
              />
              {pickerAvailable && (
                <button type="button" onClick={onPickExecutable} className={cn(PILL, "flex-none")}>
                  选择…
                </button>
              )}
            </div>
          </label>
          <label className="flex flex-col gap-2xs">
            <span className="text-fg-faint text-sm">参数（每行一个）</span>
            <textarea
              value={form.argsText}
              onChange={(event) => set("argsText", event.target.value)}
              rows={3}
              className={TEXTAREA_CLASS}
            />
          </label>
          <label className="flex flex-col gap-2xs">
            <span className="text-fg-faint text-sm">环境变量（每行 KEY=VALUE）</span>
            <textarea
              value={form.envText}
              onChange={(event) => set("envText", event.target.value)}
              rows={3}
              className={TEXTAREA_CLASS}
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-sm">URL</span>
          <input
            value={form.url}
            onChange={(event) => set("url", event.target.value)}
            placeholder="https://example.com/mcp"
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </label>
      )}

      {error != null && <p className="text-danger text-sm">{error}</p>}

      <div className="flex justify-end gap-2xs">
        <button type="button" onClick={onCancel} className={PILL}>
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex h-lg items-center rounded-full bg-brand px-sm text-brand-fg text-sm"
        >
          确定
        </button>
      </div>
    </div>
  );
}

/**
 * The settings page: 运行模式, the global tool allowlist, 外观, 系统通知, the
 * model providers, the default model, the worktree cap, and the MCP server
 * list. One local draft, edited freely and sent whole on 保存; the server
 * snapshot only overwrites it while there is nothing unsaved to lose.
 *
 * 外观 and the Computer Use switch are the exception — they write on the click
 * and are kept out of the draft's comparison and payload (see `withoutAppearance`).
 */
export function SettingsView({
  settings,
  engines,
  client,
  onClose,
}: {
  settings: Settings | null;
  /** 引擎能力表, for the grouped 默认模型 picker. */
  engines: EngineDescriptor[];
  client: ApiClient;
  onClose: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(settings == null ? null : settingsKey(settings));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<McpForm | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerAvailable, setPickerAvailable] = useState(true);
  const [tab, setTab] = useState<SettingsTab>("general");

  // Re-synced from the server only while the draft has no edits the user would lose.
  useEffect(() => {
    if (settings == null) return;
    setDraft((current) =>
      current != null && savedSnapshot != null && settingsKey(current) !== savedSnapshot ? current : settings,
    );
    setSavedSnapshot(settingsKey(settings));
    // `savedSnapshot` is read as "the last snapshot before this update", not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A palette or dialog on top takes its own Esc (and marks it handled) before this sees it.
      if (event.key === "Escape" && !event.defaultPrevented && !isImeKeyEvent(event)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (draft == null) {
    return <div className="p-md text-fg-faint text-md">加载中…</div>;
  }

  const dirty = savedSnapshot != null && settingsKey(draft) !== savedSnapshot;
  const update = (patch: Partial<Settings>) => setDraft((current) => (current == null ? current : { ...current, ...patch }));
  const servers = draft.mcpServers ?? [];

  const save = () => {
    setSaving(true);
    setSaveError(null);
    void client
      // 外观 owns 主题 / 密度 and writes them on the click, so they are left out
      // of this payload — sending the snapshot back would undo a later change.
      .putSettings(withoutAppearance(draft))
      .then((result) => {
        setDraft(result);
        setSavedSnapshot(settingsKey(result));
        toast("已保存");
      })
      .catch((error: Error) => setSaveError(error.message))
      .finally(() => setSaving(false));
  };

  // Written on the click like 外观; a failed write puts the switch back.
  const setComputerUse = (value: boolean) => {
    const previous = draft.computerUseProvider ?? null;
    update({ computerUseProvider: value ? "cua" : null });
    void client.putSettings({ computerUseProvider: value ? "cua" : null }).catch((error: Error) => {
      update({ computerUseProvider: previous });
      toast(error.message);
    });
  };

  const openAddForm = () => {
    setEditingIndex(null);
    setForm(EMPTY_MCP_FORM);
    setFormError(null);
  };
  const openEditForm = (index: number) => {
    const config = servers[index];
    if (config == null) return;
    setEditingIndex(index);
    setForm(toForm(config));
    setFormError(null);
  };
  const closeForm = () => {
    setForm(null);
    setEditingIndex(null);
    setFormError(null);
  };
  const commitForm = () => {
    if (form == null) return;
    const result = fromForm(form);
    if ("error" in result) {
      setFormError(result.error);
      return;
    }
    const next = [...servers];
    if (editingIndex == null) next.push(result);
    else next[editingIndex] = result;
    update({ mcpServers: next });
    closeForm();
  };
  const removeServer = (index: number) => update({ mcpServers: servers.filter((_, i) => i !== index) });

  const pickExecutable = () => {
    void client
      .pickFile()
      .then((path) => {
        if (path != null) setForm((current) => (current == null ? current : { ...current, command: path }));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "picker_unavailable") setPickerAvailable(false);
      });
  };

  const pages: Record<SettingsTab, ReactNode> = {
    general: (
      <SettingsPage title="通用">
        <NotificationsSection enabled={draft.systemNotifications !== false} onChange={(value) => update({ systemNotifications: value })} />
      </SettingsPage>
    ),

    appearance: (
      <SettingsPage title="外观">
        <AppearanceSection />
      </SettingsPage>
    ),

    agents: (
      <SettingsPage title="Agents">
        <RuntimesSection
          client={client}
          autoUpgrade={draft.autoUpgradeRuntimes !== false}
          onAutoUpgrade={(value) => update({ autoUpgradeRuntimes: value })}
        />
      </SettingsPage>
    ),

    remote: <RemotePage client={client} />,

    providers: <ProvidersPage client={client} engines={engines} />,

    mcp: (
      <SettingsPage title="工具与 MCP">
        <SettingsGroup title="MCP 服务器">
          {servers.map((config, index) => {
            const { kind, detail } = describeServer(config);
            return (
              <SettingsRow
                key={`${config.name}-${index}`}
                title={
                  <>
                    <span className="truncate font-medium">{config.name}</span>
                    <Tag>{kind}</Tag>
                  </>
                }
                help={<span className="block truncate font-mono">{detail}</span>}
              >
                <button
                  type="button"
                  onClick={() => openEditForm(index)}
                  title="编辑"
                  className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <Pencil className="size-md" />
                </button>
                <button
                  type="button"
                  onClick={() => removeServer(index)}
                  title="删除"
                  className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-danger-bg hover:text-danger"
                >
                  <Trash2 className="size-md" />
                </button>
              </SettingsRow>
            );
          })}
          {servers.length === 0 && <SettingsEmpty>还没有配置 MCP 服务器。</SettingsEmpty>}
        </SettingsGroup>

        {form != null ? (
          <McpFormPanel
            form={form}
            error={formError}
            pickerAvailable={pickerAvailable}
            onChange={setForm}
            onPickExecutable={pickExecutable}
            onCancel={closeForm}
            onSubmit={commitForm}
          />
        ) : (
          <button type="button" onClick={openAddForm} className={cn(BUTTON_SECONDARY, "w-fit")}>
            <Plus className="size-md" />
            添加服务器
          </button>
        )}
      </SettingsPage>
    ),

    computer: (
      <SettingsPage title="Computer Use">
        <ComputerUseSection
          client={client}
          enabled={draft.computerUseProvider === "cua"}
          onEnabledChange={setComputerUse}
        />
      </SettingsPage>
    ),

    worktrees: (
      <SettingsPage title="Worktrees">
        <SettingsGroup>
          <SettingsRow title="worktree 上限" help="超过这个数量就回收最旧的空闲任务目录；留空用默认值 25。">
            <input
              type="number"
              min={1}
              step={1}
              value={draft.worktreeMaxCount ?? ""}
              placeholder="25"
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = Number.parseInt(raw, 10);
                // Empty restores the built-in default; the server validates the rest.
                setDraft((current) => {
                  if (current == null) return current;
                  if (raw === "" || !Number.isInteger(parsed) || parsed < 1) {
                    const { worktreeMaxCount: _dropped, ...rest } = current;
                    return rest;
                  }
                  return { ...current, worktreeMaxCount: parsed };
                });
              }}
              className={cn(INPUT_CLASS, "w-[calc(var(--spacing-3xl)*2)] font-mono")}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsPage>
    ),
  };

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="设置" className="flex w-[calc(var(--spacing-3xl)*4)] flex-none flex-col gap-3xs border-border border-r bg-bg-sidebar p-md">
        <h1 className="mb-sm px-sm font-semibold text-fg text-md leading-[var(--spacing-xl)]">设置</h1>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={tab === entry.id ? "page" : undefined}
            onClick={() => setTab(entry.id)}
            className={cn(
              "flex h-row items-center gap-sm rounded-md px-sm text-left text-fg-secondary text-sm hover:bg-bg-hover hover:text-fg",
              tab === entry.id && "bg-bg-active text-fg",
            )}
          >
            <entry.icon className="size-lg flex-none" />
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-md px-2xl py-xl">
          {pages[tab]}
          {(dirty || saveError != null) && (
            <div className="sticky bottom-0 flex items-center gap-sm rounded-lg border border-border bg-bg-elevated px-md py-xs shadow-lg">
              <span className={cn("min-w-0 flex-1 truncate text-sm", saveError != null ? "text-danger" : "text-fg-muted")}>{saveError ?? "有还没保存的修改"}</span>
              <button type="button" disabled={!dirty || saving} onClick={save} className={BUTTON_PRIMARY}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
