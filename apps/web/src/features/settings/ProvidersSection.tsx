import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, ProviderAgent, ProviderPreset, ProviderProtocol, RedactedProviderConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  emptyProviderForm,
  formFromPreset,
  formFromProvider,
  summarizeAgents,
  toProviderInput,
  toggleModel,
  withDiscovered,
  type AgentForm,
  type ProviderForm,
} from "./providerForm";
import { INPUT_CLASS, PILL, PILL_SELECTED } from "./styles";

const PROTOCOLS: ReadonlyArray<{ id: ProviderProtocol; label: string }> = [
  { id: "openai-compatible", label: "OpenAI 兼容" },
  { id: "anthropic", label: "Anthropic 兼容" },
];

const ROW_BUTTON = "grid size-lg flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg";

/** One agent's block: on/off, where it connects, 拉取, and the models to tick. */
function AgentBlock({
  label,
  agent,
  form,
  busy,
  note,
  onChange,
  onDiscover,
}: {
  label: string;
  agent: ProviderAgent;
  form: AgentForm;
  busy: boolean;
  /** What the last 拉取 said, when it said anything: how many came back, or why none did. */
  note: string | undefined;
  onChange: (next: AgentForm) => void;
  onDiscover: () => void;
}) {
  const [manual, setManual] = useState("");
  const addManual = () => {
    const id = manual.trim();
    if (id === "") return;
    onChange({
      ...withDiscovered(form, [{ id }]),
      selected: form.selected.includes(id) ? form.selected : [...form.selected, id],
    });
    setManual("");
  };

  return (
    <div className="flex flex-col gap-xs rounded-md border border-border bg-bg-elevated px-sm py-xs">
      <label className="flex items-center gap-xs text-fg text-sm">
        <input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} className="accent-brand" />
        <span className="font-medium">给 {label} 用</span>
      </label>

      {form.enabled && (
        <>
          <div className="flex flex-wrap items-center gap-xs">
            <input
              value={form.baseURL}
              onChange={(event) => onChange({ ...form, baseURL: event.target.value })}
              placeholder="接入地址，如 https://api.example.com/v1"
              spellCheck={false}
              className={cn(INPUT_CLASS, "min-w-0 flex-1 font-mono text-xs")}
            />
            <button type="button" onClick={onDiscover} disabled={busy || form.baseURL.trim() === ""} className={PILL}>
              <RefreshCw className={cn("mr-2xs size-xs", busy && "animate-spin")} />
              拉取模型
            </button>
          </div>

          {/* Claude Code speaks one protocol; only the in-house agent has a choice to make. */}
          {agent === "vgent" && (
            <div className="flex flex-wrap items-center gap-2xs">
              <span className="text-fg-faint text-xs">协议</span>
              {PROTOCOLS.map((protocol) => (
                <button
                  key={protocol.id}
                  type="button"
                  onClick={() => onChange({ ...form, protocol: protocol.id })}
                  className={cn(PILL, form.protocol === protocol.id && PILL_SELECTED)}
                >
                  {protocol.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-3xs">
            {form.candidates.map((model) => (
              <label key={model.id} className="flex items-center gap-xs text-sm">
                <input type="checkbox" checked={form.selected.includes(model.id)} onChange={() => onChange(toggleModel(form, model.id))} className="accent-brand" />
                <span className="min-w-0 truncate font-mono text-fg text-xs">{model.id}</span>
                {model.label != null && <span className="min-w-0 truncate text-fg-faint text-xs">{model.label}</span>}
              </label>
            ))}
            {form.candidates.length === 0 && <p className="text-fg-faint text-xs">还没有可选的模型，点「拉取模型」。</p>}
          </div>

          {note != null && <p className="text-fg-faint text-xs">{note}</p>}

          {/* The fallback, not the way in: some endpoints simply have no model listing. */}
          <div className="flex items-center gap-xs">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addManual();
                }
              }}
              placeholder="拉不到时手动加一个模型 id"
              spellCheck={false}
              className={cn(INPUT_CLASS, "min-w-0 flex-1 font-mono text-xs")}
            />
            <button type="button" onClick={addManual} disabled={manual.trim() === ""} className={PILL}>
              添加
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 模型提供商: accounts the agents can run on besides their own logins. Saved
 * per provider, on the spot — unlike the rest of the page it is not part of the
 * settings draft, because its key goes to a store that never sends it back.
 */
export function ProvidersSection({
  client,
  engines,
  onChanged,
}: {
  client: ApiClient;
  engines: readonly EngineDescriptor[];
  /** A provider was added, edited or removed: every model list on screen is now stale. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [providers, setProviders] = useState<RedactedProviderConfig[] | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** `picking` = choosing a preset; a form = filling one in. */
  const [stage, setStage] = useState<"idle" | "picking" | ProviderForm>("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState<ProviderAgent | null>(null);
  const [notes, setNotes] = useState<Partial<Record<ProviderAgent, string>>>({});
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  // 能力缺失就明说: which engines can take a provider is the capability table's call, not this file's.
  const usable = engines.filter((engine) => engine.capabilities.customProviders).map((engine) => engine.id as ProviderAgent);
  const unusable = engines.filter((engine) => !engine.capabilities.customProviders);
  const labelOf = (agent: ProviderAgent) => engines.find((engine) => engine.id === agent)?.label ?? agent;

  const reload = useCallback(() => {
    client.listProviders().then(
      (body) => {
        setProviders(body.providers);
        setPresets(body.presets);
        setLoadError(null);
      },
      (error: Error) => setLoadError(error.message),
    );
  }, [client]);

  useEffect(reload, [reload]);

  const open = (form: ProviderForm) => {
    setStage(form);
    setFormError(null);
    setNotes({});
  };
  const close = () => {
    setStage("idle");
    setFormError(null);
    setNotes({});
  };

  const form = typeof stage === "object" ? stage : null;
  const setAgent = (agent: ProviderAgent, next: AgentForm) => {
    if (form != null) setStage({ ...form, agents: { ...form.agents, [agent]: next } });
  };

  const discover = (agent: ProviderAgent) => {
    if (form == null) return;
    const block = form.agents[agent];
    setDiscovering(agent);
    client
      .discoverProviderModels({
        ...(form.id != null ? { providerId: form.id } : {}),
        baseURL: block.baseURL.trim(),
        protocol: block.protocol,
        ...(form.apiKey.trim() !== "" ? { apiKey: form.apiKey.trim() } : {}),
      })
      .then(
        (models) => {
          // The form may have moved on while this was in flight; fold into whatever it is now.
          setStage((current) =>
            typeof current === "object" ? { ...current, agents: { ...current.agents, [agent]: withDiscovered(current.agents[agent], models) } } : current,
          );
          setNotes((current) => ({ ...current, [agent]: `拉到 ${models.length} 个模型，勾选要用的。` }));
        },
        (error: Error) => setNotes((current) => ({ ...current, [agent]: `${error.message}。可以用下面的输入框手动加。` })),
      )
      .finally(() => setDiscovering(null));
  };

  const save = () => {
    if (form == null) return;
    const result = toProviderInput(form, usable);
    if ("error" in result) {
      setFormError(result.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    (form.id != null ? client.updateProvider(form.id, result.input) : client.createProvider(result.input))
      .then(
        () => {
          toast(form.id != null ? "提供商已更新" : "提供商已添加");
          close();
          reload();
          onChanged();
        },
        (error: Error) => setFormError(error.message),
      )
      .finally(() => setSaving(false));
  };

  const remove = (id: string) => {
    client.deleteProvider(id).then(
      () => {
        setConfirmingDelete(null);
        toast("提供商已删除");
        reload();
        onChanged();
      },
      (error: Error) => setLoadError(error.message),
    );
  };

  return (
    <section className="flex flex-col gap-sm">
      <h2 className="font-semibold text-fg text-sm">模型提供商</h2>
      <p className="text-fg-faint text-xs">除了各自的登录，agent 还能用这里接入的模型。填一次 key，勾选每个 agent 要用的模型，它们就出现在模型选择器里。</p>

      <div className="flex flex-col gap-2xs">
        {(providers ?? []).map((provider) => (
          <div key={provider.id} className="flex items-center gap-xs rounded-md border border-border bg-bg-elevated px-sm py-xs">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2xs">
                <span className="truncate font-medium text-fg text-sm">{provider.name}</span>
                <span className={cn("flex-none rounded-full px-2xs text-2xs", provider.hasKey ? "bg-bg-inset text-fg-faint" : "bg-warning-bg text-warning")}>
                  {provider.hasKey ? "key 已保存" : "没有 key"}
                </span>
              </div>
              <div className="truncate text-fg-faint text-xs">{summarizeAgents(provider, labelOf)}</div>
            </div>
            {confirmingDelete === provider.id ? (
              <>
                <span className="flex-none text-fg-faint text-xs">用它的任务会跑不起来，确定？</span>
                <button type="button" onClick={() => remove(provider.id)} className={cn(PILL, "border-danger text-danger hover:border-danger hover:text-danger")}>
                  删除
                </button>
                <button type="button" onClick={() => setConfirmingDelete(null)} className={PILL}>
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  title="编辑"
                  onClick={() => open(formFromProvider(provider, presets.find((preset) => preset.id === provider.presetId)))}
                  className={ROW_BUTTON}
                >
                  <Pencil className="size-xs" />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => setConfirmingDelete(provider.id)}
                  className={cn(ROW_BUTTON, "hover:bg-danger-bg hover:text-danger")}
                >
                  <Trash2 className="size-xs" />
                </button>
              </>
            )}
          </div>
        ))}
        {providers != null && providers.length === 0 && stage === "idle" && <p className="text-fg-faint text-xs">还没有接入提供商。</p>}
        {providers == null && loadError == null && <p className="text-fg-faint text-xs">加载中…</p>}
      </div>

      {stage === "idle" && (
        <button
          type="button"
          onClick={() => setStage("picking")}
          className="inline-flex h-xl w-fit items-center gap-2xs rounded-md border border-border border-dashed px-sm text-fg-muted text-sm hover:border-border-strong hover:text-fg"
        >
          <Plus className="size-md" />
          添加提供商
        </button>
      )}

      {stage === "picking" && (
        <div className="flex flex-col gap-xs rounded-md border border-border bg-bg-inset p-sm">
          <span className="text-fg-muted text-xs">从预设开始，只差填 key；或者自定义一个兼容的接入地址。</span>
          <div className="flex flex-wrap gap-2xs">
            {presets.map((preset) => (
              <button key={preset.id} type="button" onClick={() => open(formFromPreset(preset))} className={PILL} title={preset.docsUrl}>
                {preset.name}
              </button>
            ))}
            <button type="button" onClick={() => open(emptyProviderForm())} className={cn(PILL, "border-dashed")}>
              自定义
            </button>
          </div>
          <div>
            <button type="button" onClick={close} className={PILL}>
              取消
            </button>
          </div>
        </div>
      )}

      {form != null && (
        <div className="flex flex-col gap-sm rounded-md border border-border bg-bg-inset p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <input
              value={form.name}
              onChange={(event) => setStage({ ...form, name: event.target.value })}
              placeholder="名称"
              className={cn(INPUT_CLASS, "w-[calc(var(--spacing-xl)*8)]")}
            />
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) => setStage({ ...form, apiKey: event.target.value })}
              placeholder={form.hasKey ? "key 已保存，留空不改" : "API key"}
              autoComplete="off"
              spellCheck={false}
              className={cn(INPUT_CLASS, "min-w-0 flex-1 font-mono text-xs")}
            />
          </div>

          {usable.map((agent) => (
            <AgentBlock
              key={agent}
              agent={agent}
              label={labelOf(agent)}
              form={form.agents[agent]}
              busy={discovering === agent}
              note={notes[agent]}
              onChange={(next) => setAgent(agent, next)}
              onDiscover={() => discover(agent)}
            />
          ))}

          {unusable.map((engine) => (
            <p key={engine.id} className="text-fg-faint text-xs">
              {engine.label} 只能用本机的登录，接不了这里的提供商。
            </p>
          ))}

          {formError != null && <p className="text-danger text-xs">{formError}</p>}

          <div className="flex items-center gap-xs">
            <button type="button" onClick={save} disabled={saving} className={cn(PILL, PILL_SELECTED)}>
              <Check className="mr-2xs size-xs" />
              {form.id != null ? "保存修改" : "添加"}
            </button>
            <button type="button" onClick={close} disabled={saving} className={PILL}>
              取消
            </button>
            <span className="text-fg-faint text-xs">key 只存在本机，任何界面和接口都不会再把它显示出来。</span>
          </div>
        </div>
      )}

      {loadError != null && <p className="text-danger text-xs">{loadError}</p>}
    </section>
  );
}
