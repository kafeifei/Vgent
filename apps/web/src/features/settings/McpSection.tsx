import { useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ApiError, type ApiClient } from "@/lib/api";
import type { McpServerConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EMPTY_MCP_FORM, fromForm, toForm, type McpForm } from "./mcpForm";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Dialog, Segmented, SettingsEmpty, SettingsGroup, SettingsRow, Tag } from "./layout";
import { INPUT_CLASS, PILL, TEXTAREA_CLASS } from "./styles";

const MCP_KINDS: ReadonlyArray<{ id: McpForm["kind"]; label: string }> = [
  { id: "stdio", label: "stdio" },
  { id: "http", label: "http" },
  { id: "sse", label: "sse" },
];

function describeServer(config: McpServerConfig): { kind: string; detail: string } {
  if ("command" in config) return { kind: "stdio", detail: [config.command, ...(config.args ?? [])].join(" ") };
  return { kind: config.transport === "sse" ? "sse" : "http", detail: config.url };
}

/** Name, type pills, and the fields for whichever type is picked. */
function McpFormPanel({
  form,
  error,
  saving,
  pickerAvailable,
  onChange,
  onPickExecutable,
  onCancel,
  onSubmit,
}: {
  form: McpForm;
  error: string | null;
  saving: boolean;
  pickerAvailable: boolean;
  onChange: (form: McpForm) => void;
  onPickExecutable: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const set = <K extends keyof McpForm>(key: K, value: McpForm[K]) => onChange({ ...form, [key]: value });

  return (
    <fieldset disabled={saving} className="flex min-w-0 flex-col gap-sm p-md">
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

      {error != null && <p role="alert" className="text-danger text-sm">{error}</p>}

      <div className="flex justify-end gap-2xs">
        <button type="button" onClick={onCancel} className={PILL}>
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex h-lg items-center rounded-full bg-brand px-sm text-brand-fg text-sm"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </fieldset>
  );
}

/** MCP changes are saved in their own dialog; no cross-page settings draft. */
export function McpSection({ servers, client, onSaved }: {
  servers: McpServerConfig[];
  client: ApiClient;
  onSaved: (servers: McpServerConfig[]) => void;
}) {
  const [form, setForm] = useState<McpForm | null>(null);
  const [original, setOriginal] = useState<McpServerConfig | null>(null);
  const [removing, setRemoving] = useState<McpServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [pickerAvailable, setPickerAvailable] = useState(true);
  const close = () => {
    if (pending.current) return;
    setForm(null);
    setOriginal(null);
    setRemoving(null);
    setError(null);
  };
  const save = async (next: McpServerConfig[]) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await client.putSettings({ mcpServers: next });
      onSaved(result.mcpServers ?? []);
      setForm(null);
      setOriginal(null);
      setRemoving(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  // A remote edit must not turn an old dialog into an edit of a different server.
  const currentIndex = (entry: McpServerConfig): number => {
    const index = servers.findIndex((server) => server.name === entry.name);
    if (index < 0 || JSON.stringify(servers[index]) !== JSON.stringify(entry)) {
      setError("这个服务器已在其他地方修改，请关闭后重新编辑。");
      return -1;
    }
    return index;
  };
  const submit = () => {
    if (form == null) return;
    const result = fromForm(form);
    if ("error" in result) { setError(result.error); return; }
    const index = original == null ? -1 : currentIndex(original);
    if (original != null && index < 0) return;
    if (servers.some((server, i) => i !== index && server.name === result.name)) {
      setError("已经有同名的 MCP 服务器，请使用其他名称。");
      return;
    }
    const next = [...servers];
    if (index < 0) next.push(result);
    else next[index] = result;
    void save(next);
  };
  const pickExecutable = () => {
    void client.pickFile().then((path) => {
      if (path != null) setForm((current) => current == null ? current : { ...current, command: path });
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.code === "picker_unavailable") setPickerAvailable(false);
      else setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  return (
    <>
      <SettingsGroup title="MCP 服务器" actions={
        <button type="button" className={BUTTON_SECONDARY} onClick={() => { setError(null); setOriginal(null); setForm(EMPTY_MCP_FORM); }}>
          <Plus className="size-md" />添加服务器
        </button>
      }>
        {servers.map((config) => {
          const { kind, detail } = describeServer(config);
          return <SettingsRow key={config.name} title={<><span className="truncate font-medium">{config.name}</span><Tag>{kind}</Tag></>}
            help={<span className="block truncate font-mono">{detail}</span>}>
            <button type="button" aria-label={`编辑 ${config.name}`} title="编辑" className="grid size-lg place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
              onClick={() => { setError(null); setOriginal(config); setForm(toForm(config)); }}><Pencil className="size-md" /></button>
            <button type="button" aria-label={`删除 ${config.name}`} title="删除" className="grid size-lg place-items-center rounded-md text-fg-muted hover:bg-danger-bg hover:text-danger"
              onClick={() => { setError(null); setRemoving(config); }}><Trash2 className="size-md" /></button>
          </SettingsRow>;
        })}
        {servers.length === 0 && <SettingsEmpty>还没有配置 MCP 服务器。</SettingsEmpty>}
      </SettingsGroup>
      {form != null && <Dialog title={original == null ? "添加 MCP 服务器" : "编辑 MCP 服务器"} onClose={close}>
        <div className="overflow-y-auto"><McpFormPanel form={form} error={error} saving={saving} pickerAvailable={pickerAvailable}
          onChange={setForm} onPickExecutable={pickExecutable} onCancel={close} onSubmit={submit} /></div>
      </Dialog>}
      {removing != null && <Dialog title={`删除 ${removing.name}`} onClose={close}>
        <div className="flex flex-col gap-md p-md">
          <p className="text-fg-muted text-sm">删除后，新回合将无法使用这个服务器提供的工具。</p>
          {error != null && <p role="alert" className="text-danger text-sm">{error}</p>}
          <div className="flex justify-end gap-xs">
            <button type="button" disabled={saving} className={BUTTON_SECONDARY} onClick={close}>取消</button>
            <button type="button" disabled={saving} className={BUTTON_PRIMARY} onClick={() => {
              const index = currentIndex(removing);
              if (index >= 0) void save(servers.filter((_, i) => i !== index));
            }}>{saving ? "删除中…" : "删除服务器"}</button>
          </div>
        </div>
      </Dialog>}
    </>
  );
}
