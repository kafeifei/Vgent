import { useEffect, useState } from "react";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { ModelPicker, modelLabel } from "@/components/ModelPicker";
import { ApiError, type ApiClient } from "@/lib/api";
import { ENGINES, PERMISSIONS } from "@/lib/engineOptions";
import { useToast } from "@/lib/toast";
import type { McpServerConfig, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EMPTY_MCP_FORM, fromForm, toForm, type McpForm } from "./mcpForm";

/** Deep-equal via a key-sorted `JSON.stringify`, so field order never causes a false "dirty". */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val != null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

const PILL =
  "inline-flex h-xl items-center rounded-full border border-border bg-bg-elevated px-sm text-fg-muted text-sm hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg-muted";
const PILL_SELECTED = "border-brand bg-brand-bg text-brand hover:border-brand hover:text-brand";
const INPUT_CLASS =
  "h-xl rounded-sm border border-border bg-bg-inset px-xs text-fg text-sm outline-none placeholder:text-fg-faint focus-visible:border-border-strong";
const TEXTAREA_CLASS =
  "resize-y rounded-sm border border-border bg-bg-inset px-xs py-2xs font-mono text-fg text-xs outline-none placeholder:text-fg-faint focus-visible:border-border-strong";

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
 * The settings page: defaults (engine / permission / model) plus the MCP
 * server list. One local draft, edited freely and sent whole on 保存; the
 * server snapshot only overwrites it while there is nothing unsaved to lose.
 */
export function SettingsView({
  settings,
  client,
  onClose,
}: {
  settings: Settings | null;
  client: ApiClient;
  onClose: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(settings == null ? null : stableStringify(settings));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<McpForm | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerAvailable, setPickerAvailable] = useState(true);

  // Re-synced from the server only while the draft has no edits the user would lose.
  useEffect(() => {
    if (settings == null) return;
    setDraft((current) =>
      current != null && savedSnapshot != null && stableStringify(current) !== savedSnapshot ? current : settings,
    );
    setSavedSnapshot(stableStringify(settings));
    // `savedSnapshot` is read as "the last snapshot before this update", not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (draft == null) {
    return <div className="p-md text-fg-faint text-sm">加载中…</div>;
  }

  const dirty = savedSnapshot != null && stableStringify(draft) !== savedSnapshot;
  const update = (patch: Partial<Settings>) => setDraft((current) => (current == null ? current : { ...current, ...patch }));
  // `defaultModel` is optional-string under `exactOptionalPropertyTypes`, so clearing it means
  // dropping the key rather than assigning `undefined` (which `update` cannot express).
  const setDefaultModel = (model: string | null) =>
    setDraft((current) => {
      if (current == null) return current;
      if (model != null) return { ...current, defaultModel: model };
      const { defaultModel: _dropped, ...rest } = current;
      return rest;
    });
  const servers = draft.mcpServers ?? [];
  const codexLocked = draft.defaultEngine === "codex";

  const save = () => {
    setSaving(true);
    setSaveError(null);
    void client
      .putSettings(draft)
      .then((result) => {
        setDraft(result);
        setSavedSnapshot(stableStringify(result));
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
        <h2 className="font-semibold text-fg text-sm">默认值</h2>

        <div className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-xs">默认引擎</span>
          <div className="flex flex-wrap gap-2xs">
            {ENGINES.map((engine) => (
              <button
                key={engine.id}
                type="button"
                aria-pressed={draft.defaultEngine === engine.id}
                onClick={() =>
                  update({
                    defaultEngine: engine.id,
                    ...(engine.id === "codex" ? { defaultPermissionMode: "allow-all" as const } : {}),
                  })
                }
                className={cn(PILL, draft.defaultEngine === engine.id && PILL_SELECTED)}
              >
                {engine.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-xs">默认权限模式</span>
          <div className="flex flex-wrap gap-2xs">
            {PERMISSIONS.map((mode) => {
              const locked = codexLocked && mode !== "allow-all";
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={locked}
                  title={locked ? "Codex 只支持 allow-all" : undefined}
                  aria-pressed={draft.defaultPermissionMode === mode}
                  onClick={() => update({ defaultPermissionMode: mode })}
                  className={cn(PILL, "font-mono", draft.defaultPermissionMode === mode && PILL_SELECTED)}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2xs">
          <span className="text-fg-faint text-xs">默认模型</span>
          <ModelPicker
            engine={draft.defaultEngine}
            model={draft.defaultModel}
            onPick={setDefaultModel}
            trigger={(props) => (
              <button type="button" {...props} className={cn(PILL, "w-fit font-mono")}>
                {modelLabel(draft.defaultModel)}
                <span className="ml-2xs opacity-60">▾</span>
              </button>
            )}
          />
        </div>
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
