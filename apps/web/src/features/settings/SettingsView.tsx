import { useEffect, useState } from "react";
import { BASH_TOOL, bashEntryCommand, isVoidedBashEntry } from "@vgent/engine/allowlist";
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import { ApiError, type ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, McpServerConfig, PermissionMode, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AppearanceSection } from "./AppearanceSection";
import { EMPTY_MCP_FORM, fromForm, toForm, type McpForm } from "./mcpForm";
import { NotificationsSection } from "./NotificationsSection";
import { ProvidersSection } from "./ProvidersSection";
import { INPUT_CLASS, PILL, PILL_SELECTED, TEXTAREA_CLASS } from "./styles";
import { isImeKeyEvent } from "@/lib/ime";

/**
 * 运行模式: three steps, each described by what it does *to you* rather than by
 * the harness flag behind it. An engine that cannot ask runs 全自动 whatever is
 * picked here — the composer says so on the task itself.
 */
const RUN_MODES: ReadonlyArray<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "allow-reads", label: "询问", hint: "读文件不问，改文件和跑命令先问" },
  { id: "allow-edits", label: "自动改文件", hint: "改文件不问，跑命令先问" },
  { id: "allow-all", label: "全自动", hint: "都不问" },
];

/**
 * One allowlist entry, in words. `bash(git push)` is a *command*, not a tool,
 * and a legacy bare `bash` is the blank cheque the old UI wrote — both have to
 * be recognisable here, because this list is the only place to take one back.
 *
 * `note` is for an entry that can no longer match anything: `bash(git)` was
 * written when an entry named only the command word. Nothing is migrated (that
 * would grant `git push` off the back of a `git status` click), so the entry is
 * shown as 已失效 with the reason, and removing it is the user's call.
 */
function describeAllowEntry(entry: string): { label: string; note?: string } {
  const command = bashEntryCommand(entry);
  if (command != null) {
    return isVoidedBashEntry(entry)
      ? { label: `命令 ${command}`, note: `已失效：${command} 现在要写到子命令（如 ${command} <子命令>），这条不再放行任何命令，可以删掉。` }
      : { label: `命令 ${command}` };
  }
  return { label: entry === BASH_TOOL ? "bash（全部命令）" : entry };
}

/** Deep-equal via a key-sorted `JSON.stringify`, so field order never causes a false "dirty". */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val != null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

/**
 * 主题 and 密度 are not part of this page's draft: 外观 applies and stores them
 * on the click. Keeping them out of both the comparison and the payload is what
 * stops 保存 from writing back the theme this page was *opened* with.
 */
function withoutAppearance(settings: Settings): Omit<Settings, "theme" | "density"> {
  const { theme: _theme, density: _density, ...rest } = settings;
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
          <span className="text-fg-faint text-xs">名称</span>
          <input value={form.name} onChange={(event) => set("name", event.target.value)} className={INPUT_CLASS} />
        </label>
        <div className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-xs">类型</span>
          <div className="flex gap-2xs">
            {(["stdio", "http", "sse"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={form.kind === kind}
                onClick={() => set("kind", kind)}
                className={cn(PILL, "h-xl px-xs text-xs", form.kind === kind && PILL_SELECTED)}
              >
                {kind}
              </button>
            ))}
          </div>
        </div>
      </div>

      {form.kind === "stdio" ? (
        <>
          <label className="flex flex-col gap-2xs">
            <span className="text-fg-faint text-xs">可执行文件</span>
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
            <span className="text-fg-faint text-xs">参数（每行一个）</span>
            <textarea
              value={form.argsText}
              onChange={(event) => set("argsText", event.target.value)}
              rows={3}
              className={TEXTAREA_CLASS}
            />
          </label>
          <label className="flex flex-col gap-2xs">
            <span className="text-fg-faint text-xs">环境变量（每行 KEY=VALUE）</span>
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
          <span className="text-fg-faint text-xs">URL</span>
          <input
            value={form.url}
            onChange={(event) => set("url", event.target.value)}
            placeholder="https://example.com/mcp"
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </label>
      )}

      {error != null && <p className="text-danger text-xs">{error}</p>}

      <div className="flex justify-end gap-2xs">
        <button type="button" onClick={onCancel} className={cn(PILL, "h-lg px-sm text-xs")}>
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex h-lg items-center rounded-full bg-brand px-sm text-brand-fg text-xs"
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
 * 外观 is the exception — it writes on the click and is kept out of the draft
 * entirely (see `withoutAppearance`).
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
  const [catalogVersion, setCatalogVersion] = useState(0);

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
      if (event.key === "Escape" && !isImeKeyEvent(event)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (draft == null) {
    return <div className="p-md text-fg-faint text-sm">加载中…</div>;
  }

  const dirty = savedSnapshot != null && settingsKey(draft) !== savedSnapshot;
  const update = (patch: Partial<Settings>) => setDraft((current) => (current == null ? current : { ...current, ...patch }));
  // 选模型即选引擎, here too: the pair is written together. `defaultModel` is
  // optional-string under `exactOptionalPropertyTypes`, so clearing it means
  // dropping the key rather than assigning `undefined` (which `update` cannot express).
  const setDefaultModel = (defaultEngine: Settings["defaultEngine"], model: string | undefined) =>
    setDraft((current) => {
      if (current == null) return current;
      if (model != null) return { ...current, defaultEngine, defaultModel: model };
      const { defaultModel: _dropped, ...rest } = current;
      return { ...rest, defaultEngine };
    });
  const servers = draft.mcpServers ?? [];
  const allowlist = draft.allowlist ?? [];

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

  return (
    <div className="mx-auto flex w-full max-w-log-max flex-col gap-lg px-md py-lg">
      <div className="flex items-center gap-sm">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-xl items-center gap-2xs rounded-md px-xs text-fg-muted text-sm hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="size-md" />
          返回
        </button>
        <h1 className="flex-1 font-semibold text-lg">设置</h1>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className="inline-flex h-xl items-center rounded-full bg-brand px-md text-brand-fg text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      <section className="flex flex-col gap-sm">
        <h2 className="font-semibold text-fg text-sm">运行模式</h2>
        <div className="flex flex-col gap-2xs">
          {RUN_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              aria-pressed={draft.runMode === mode.id}
              onClick={() => update({ runMode: mode.id })}
              className={cn(
                "flex w-full flex-col items-start gap-3xs rounded-md border border-border bg-bg-elevated px-sm py-xs text-left hover:border-border-strong",
                draft.runMode === mode.id && "border-brand bg-brand-bg hover:border-brand",
              )}
            >
              <span className={cn("text-fg text-sm", draft.runMode === mode.id && "text-brand")}>{mode.label}</span>
              <span className="text-fg-faint text-xs">{mode.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-sm">
        <h2 className="font-semibold text-fg text-sm">一直允许的工具</h2>
        <div className="flex flex-col gap-2xs">
          {allowlist.map((tool) => {
            const { label, note } = describeAllowEntry(tool);
            return (
              <div key={tool} className="flex items-center gap-xs rounded-md border border-border bg-bg-elevated px-sm py-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg text-sm" title={tool}>
                    {label}
                  </div>
                  {note != null && <div className="text-fg-faint text-xs">{note}</div>}
                </div>
                <button
                  type="button"
                  title="撤销"
                  onClick={() => update({ allowlist: allowlist.filter((name) => name !== tool) })}
                  className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-danger-bg hover:text-danger"
                >
                  <X className="size-xs" />
                </button>
              </div>
            );
          })}
          {allowlist.length === 0 && <p className="text-fg-faint text-xs">还没有一直允许的工具。审批卡上点「一直允许」会加到这里。</p>}
        </div>
      </section>

      <AppearanceSection />

      <NotificationsSection
        enabled={draft.systemNotifications !== false}
        onChange={(value) => update({ systemNotifications: value })}
      />

      <ProvidersSection client={client} engines={engines} onChanged={() => setCatalogVersion((version) => version + 1)} />

      <section className="flex flex-col gap-sm">
        <h2 className="font-semibold text-fg text-sm">默认模型</h2>
        <ModelPicker
          // Remounted when a provider changes: its lists are loaded once per mount.
          key={catalogVersion}
          engines={engines}
          engine={draft.defaultEngine}
          model={draft.defaultModel}
          onPick={setDefaultModel}
          trigger={(props, chip) => (
            <button type="button" {...props} className={cn(PILL, "w-fit font-mono")}>
              {chip.label}
              <span className="ml-2xs opacity-60">▾</span>
            </button>
          )}
        />
      </section>

      <section className="flex flex-col gap-sm">
        <h2 className="font-semibold text-fg text-sm">worktree 上限</h2>
        <label className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-xs">超过这个数量就回收最旧的空闲任务目录；留空用默认值 25。</span>
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
        </label>
      </section>

      <section className="flex flex-col gap-sm">
        <h2 className="font-semibold text-fg text-sm">MCP 服务器</h2>

        <div className="flex flex-col gap-2xs">
          {servers.map((config, index) => {
            const { kind, detail } = describeServer(config);
            return (
              <div
                key={`${config.name}-${index}`}
                className="flex items-center gap-xs rounded-md border border-border bg-bg-elevated px-sm py-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2xs">
                    <span className="truncate font-medium text-fg text-sm">{config.name}</span>
                    <span className="flex-none rounded-full bg-bg-inset px-2xs text-2xs text-fg-faint uppercase">{kind}</span>
                  </div>
                  <div className="truncate font-mono text-fg-faint text-xs">{detail}</div>
                </div>
                <button
                  type="button"
                  onClick={() => openEditForm(index)}
                  title="编辑"
                  className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <Pencil className="size-xs" />
                </button>
                <button
                  type="button"
                  onClick={() => removeServer(index)}
                  title="删除"
                  className="grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-danger-bg hover:text-danger"
                >
                  <Trash2 className="size-xs" />
                </button>
              </div>
            );
          })}
          {servers.length === 0 && form == null && <p className="text-fg-faint text-xs">还没有配置 MCP 服务器。</p>}
        </div>

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
          <button
            type="button"
            onClick={openAddForm}
            className="inline-flex h-xl w-fit items-center gap-2xs rounded-md border border-border border-dashed px-sm text-fg-muted text-sm hover:border-border-strong hover:text-fg"
          >
            <Plus className="size-md" />
            添加服务器
          </button>
        )}

        {saveError != null && <p className="text-danger text-xs">{saveError}</p>}
        <p className="text-fg-faint text-xs">自研引擎每轮启动时连接；修改后下一轮生效。</p>
      </section>
    </div>
  );
}
