import { CascadeLevel, type CascadeNode } from "@/components/CascadeMenu";
import { Popover } from "@/components/Popover";
import { SourceIcon } from "@/components/SourceIcon";
import { useAccountLogin } from "@/features/accounts/AccountLogin";
import { AccountLogo } from "@/features/accounts/AccountLogo";
import { ACCOUNT_NAMES } from "@/features/accounts/accountOf";
import { onAccountsChanged } from "@/lib/accountEvents";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, GripVertical, LayoutGrid, Plus, Server } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { ApiError, type ApiClient, type ProviderCatalog } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { AccountKind, CatalogProviderSummary, EngineDescriptor, ProviderAgent, ProviderModel, RedactedProviderConfig, SubscriptionAccount, SubscriptionId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, Dialog, LetterAvatar, Segmented, SettingsEmpty, SettingsGroup, SettingsPage, SettingsRow, Switch, Tag } from "./layout";
import { ModelTable } from "./ModelTable";
import { AGENT_ORDER, EMPTY_CUSTOM_FORM, agentsOf, connectInput, connectableCatalog, customInput, describeSubscription, orderAdded, summarizeEnabled, summarizeSubscription, withAgentChoices, withShownOrder, type CustomForm } from "./providerModels";
import { SubscriptionTable } from "./SubscriptionTable";
import { INPUT_CLASS } from "./styles";

type AgentLabel = (agent: ProviderAgent) => string;

const FIELD_LABEL = "text-fg-muted text-sm";

const PROTOCOLS: ReadonlyArray<{ id: CustomForm["protocol"]; label: string }> = [
  { id: "openai-compatible", label: "OpenAI 兼容" },
  { id: "anthropic", label: "Anthropic 兼容" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2xs">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {hint != null && <span className="text-fg-faint text-sm">{hint}</span>}
    </label>
  );
}

/** Which agents a catalog provider can serve, in words: `自研 · Claude Code`. */
function servedAgents(entry: CatalogProviderSummary, usable: readonly ProviderAgent[], label: AgentLabel): string {
  return AGENT_ORDER.filter((agent) => usable.includes(agent) && entry.agents[agent] != null)
    .map(label)
    .join(" · ");
}

/**
 * Connecting is two steps in one dialog: the key (and the address, for the few
 * providers whose address is the user's own), then the model table of the
 * provider that was just created. Where the provider has a model listing, the
 * key is checked against it before anything is saved.
 */
function ConnectDialog({
  client,
  entry,
  usable,
  agentLabel,
  onConnected,
  onProvider,
  onClose,
}: {
  client: ApiClient;
  entry: CatalogProviderSummary;
  usable: readonly ProviderAgent[];
  agentLabel: AgentLabel;
  onConnected: (provider: RedactedProviderConfig) => void;
  onProvider: (provider: RedactedProviderConfig) => void;
  onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState<{ provider: RedactedProviderConfig; discovered?: ProviderModel[] }>();

  const needsBaseURL = usable.some((agent) => entry.agents[agent] != null && entry.agents[agent]?.baseURL == null);

  const submit = async () => {
    const result = connectInput(entry, usable, { apiKey, baseURL });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const endpoint = result.input.agents.vgent ?? result.input.agents["claude-code"] ?? result.input.agents.codex;
      let discovered: ProviderModel[] | undefined;
      if (endpoint != null) {
        try {
          discovered = await client.discoverProviderModels({ baseURL: endpoint.baseURL, protocol: endpoint.protocol, ...(result.input.apiKey != null ? { apiKey: result.input.apiKey } : {}) });
        } catch (cause) {
          // No listing, a timeout, a 404: not every provider can be asked. A refused key is the one thing that stops here.
          if (cause instanceof ApiError && cause.code === "provider_key_rejected") throw cause;
        }
      }
      const provider = await client.createProvider(result.input);
      onConnected(provider);
      setConnected({ provider, ...(discovered != null ? { discovered } : {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (connected != null) {
    return (
      <Dialog title={`${entry.name} · 选模型`} onClose={onClose} wide>
        <p className="border-border border-b px-lg py-xs text-fg-faint text-sm">已连接。打开哪个 agent 的开关，模型就出现在它的模型选择器里；之后点这家的「模型」随时能改。</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ModelTable
            client={client}
            provider={connected.provider}
            agentLabel={agentLabel}
            availableAgents={usable}
            {...(connected.discovered != null ? { initialDiscovered: connected.discovered } : {})}
            onProvider={(next) => {
              setConnected((current) => (current == null ? current : { ...current, provider: next }));
              onProvider(next);
            }}
          />
        </div>
        <div className="flex justify-end border-border border-t px-lg py-sm">
          <button type="button" onClick={onClose} className={BUTTON_PRIMARY}>
            完成
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`连接 ${entry.name}`} onClose={onClose}>
      <form
        className="flex flex-col gap-md px-lg py-md"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-fg-faint text-sm">
          {servedAgents(entry, usable, agentLabel)} 能用 · 目录里有 {entry.modelCount} 个模型 · 通过 <span className="font-mono">{entry.npm}</span> 接入
          {entry.docsUrl != null && (
            <>
              {" · "}
              <a href={entry.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-3xs text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                文档
                <ExternalLink className="size-md" />
              </a>
            </>
          )}
        </p>
        {needsBaseURL && (
          <Field label="接入地址" hint="这家的地址因账号而异，得填你自己的。">
            <input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={entry.baseURLHint ?? "https://…"} spellCheck={false} className={cn(INPUT_CLASS, "font-mono")} />
          </Field>
        )}
        <Field label="API key" hint={entry.keyless === true ? "本机服务不用 key，留空即可。" : "只存在这台机器上，存了以后任何界面都不会再显示它。"}>
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={entry.keyless === true ? "留空" : "粘贴 key"}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>
        {error != null && <p className="text-danger text-sm">{error}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" onClick={onClose} className={BUTTON_GHOST}>
            取消
          </button>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A provider that is in no catalog — a company gateway, a self-hosted server. Same two steps. */
function CustomDialog({
  client,
  usable,
  agentLabel,
  onConnected,
  onProvider,
  onClose,
}: {
  client: ApiClient;
  usable: readonly ProviderAgent[];
  agentLabel: AgentLabel;
  onConnected: (provider: RedactedProviderConfig) => void;
  onProvider: (provider: RedactedProviderConfig) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CustomForm>(EMPTY_CUSTOM_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState<RedactedProviderConfig>();
  const set = (patch: Partial<CustomForm>) => setForm((current) => ({ ...current, ...patch }));

  const submit = () => {
    const result = customInput(form, usable);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    void client
      .createProvider(result.input)
      .then((provider) => {
        onConnected(provider);
        setConnected(provider);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  if (connected != null) {
    return (
      <Dialog title={`${connected.name} · 选模型`} onClose={onClose} wide>
        <p className="border-border border-b px-lg py-xs text-fg-faint text-sm">已连接。模型清单是向这个地址现拉的；拉不到就在底下手动加模型 id。</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ModelTable
            client={client}
            provider={connected}
            agentLabel={agentLabel}
            availableAgents={usable}
            onProvider={(next) => {
              setConnected(next);
              onProvider(next);
            }}
          />
        </div>
        <div className="flex justify-end border-border border-t px-lg py-sm">
          <button type="button" onClick={onClose} className={BUTTON_PRIMARY}>
            完成
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="自定义提供商" onClose={onClose}>
      <form
        className="flex flex-col gap-md px-lg py-md"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="text-fg-faint text-sm">公司网关、自己搭的服务、目录里没有的厂商：只要它说 OpenAI 或 Anthropic 的协议就能接。</p>
        <Field label="名字">
          <input autoFocus value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="比如：公司网关" className={INPUT_CLASS} />
        </Field>
        <div className="flex flex-col gap-2xs">
          <span className={FIELD_LABEL}>协议</span>
          <Segmented label="协议" value={form.protocol} options={PROTOCOLS} onChange={(protocol) => set({ protocol })} />
        </div>
        <Field label="接入地址">
          <input
            value={form.baseURL}
            onChange={(event) => set({ baseURL: event.target.value })}
            placeholder={form.protocol === "anthropic" ? "https://example.com/anthropic" : "https://example.com/v1"}
            spellCheck={false}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>
        {form.protocol === "openai-compatible" && usable.includes("claude-code") && (
          <Field label={`${agentLabel("claude-code")} 用的地址（可选）`} hint="Claude Code 只说 Anthropic 协议。同一个服务要是也有 Anthropic 兼容的地址，填在这里它就也能用。">
            <input value={form.claudeBaseURL} onChange={(event) => set({ claudeBaseURL: event.target.value })} placeholder="https://example.com/anthropic" spellCheck={false} className={cn(INPUT_CLASS, "font-mono")} />
          </Field>
        )}
        {form.protocol === "openai-compatible" && usable.includes("codex") && (
          <div className="flex items-start gap-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-2xs">
              <span className={FIELD_LABEL}>{agentLabel("codex")} 也用它</span>
              <span className="text-fg-faint text-sm">Codex 只说 OpenAI 的 Responses 协议（上面的地址加 /responses）。这个服务支持才打开；只有聊天补全接口的服务，Codex 用不了。</span>
            </div>
            <Switch checked={form.codexResponses} onChange={(on) => set({ codexResponses: on })} label={`${agentLabel("codex")} 也用这个提供商`} />
          </div>
        )}
        <Field label="API key" hint="没有 key 的本机服务可以留空。">
          <input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => set({ apiKey: event.target.value })} placeholder="粘贴 key" className={cn(INPUT_CLASS, "font-mono")} />
        </Field>
        {error != null && <p className="text-danger text-sm">{error}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" onClick={onClose} className={BUTTON_GHOST}>
            取消
          </button>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * 添加 → 更多 N 个提供商: the catalog behind a search box, as a submenu. What
 * this build cannot connect is left out; one already connected can be connected again.
 */
function CatalogMenu({
  catalog,
  connectedIds,
  reloading,
  onReload,
  onPick,
}: {
  catalog: ProviderCatalog | undefined;
  connectedIds: ReadonlySet<string>;
  reloading: boolean;
  onReload: () => void;
  onPick: (entry: CatalogProviderSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const nodes = useMemo<CascadeNode[]>(
    () =>
      connectableCatalog(catalog?.providers ?? [], query).map((entry) => ({
        key: entry.id,
        label: entry.name,
        icon: <SourceIcon source={{ kind: "provider", name: entry.name, logo: entry.id }} />,
        ...(connectedIds.has(entry.id) ? { hint: "已连接" } : {}),
        onPick: () => onPick(entry),
      })),
    [catalog, connectedIds, query, onPick],
  );

  return (
    <div className="w-[calc(var(--spacing-3xl)*4)]">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索提供商"
        aria-label="搜索提供商"
        spellCheck={false}
        className="block w-full border-border border-b bg-transparent px-xs py-2xs text-fg text-sm outline-none placeholder:text-fg-faint"
      />
      <CascadeLevel nodes={nodes} className="max-h-[calc(var(--spacing-xl)*14)] overflow-y-auto pt-2xs" />
      {nodes.length === 0 && <div className="px-xs py-2xs text-fg-faint text-sm">{catalog == null ? "加载中…" : "没有匹配的提供商"}</div>}
      {catalog?.source === "builtin" && (
        <div className="flex items-center gap-xs border-border border-t px-xs pt-2xs text-2xs text-fg-faint">
          <span className="min-w-0 flex-1">连不上 models.dev</span>
          <button type="button" disabled={reloading} onClick={onReload} className="text-fg-muted hover:text-fg">
            {reloading ? "重试中…" : "重试"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Changing what a connection is made of: its name, its key, its addresses. The models are the 模型 page's business. */
function EditDialog({
  client,
  provider,
  usable,
  agentLabel,
  onSaved,
  onClose,
}: {
  client: ApiClient;
  provider: RedactedProviderConfig;
  usable: readonly ProviderAgent[];
  agentLabel: AgentLabel;
  onSaved: (provider: RedactedProviderConfig) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [apiKey, setApiKey] = useState("");
  const [urls, setUrls] = useState<Partial<Record<ProviderAgent, string>>>(() => Object.fromEntries(agentsOf(provider).map((agent) => [agent, provider.agents[agent]?.baseURL ?? ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Which other agents use it is the 自定义 dialog's choice, and stays changeable here. A catalog
  // provider's agents are the catalog's to say.
  const choosable = provider.presetId == null && provider.agents.vgent?.protocol === "openai-compatible";
  const [codex, setCodex] = useState(provider.agents.codex != null);
  const [claudeBaseURL, setClaudeBaseURL] = useState(provider.agents["claude-code"]?.baseURL ?? "");
  /** The agents with an address row of their own; the two below are edited through their choice instead. */
  const addressed = agentsOf(provider).filter((agent) => !choosable || agent === "vgent");

  const submit = () => {
    if (name.trim() === "") {
      setError("名字不能空着");
      return;
    }
    let agents = { ...provider.agents };
    for (const agent of addressed) {
      const current = agents[agent];
      const baseURL = (urls[agent] ?? "").trim();
      if (current == null) continue;
      if (baseURL === "") {
        setError(`${agentLabel(agent)} 的接入地址不能空着`);
        return;
      }
      agents[agent] = { ...current, baseURL };
    }
    if (choosable) {
      const chosen = withAgentChoices(agents, { codex, claudeBaseURL }, usable, provider.agents);
      if ("error" in chosen) {
        setError(chosen.error);
        return;
      }
      agents = chosen.agents;
    }
    setBusy(true);
    setError(undefined);
    void client
      .updateProvider(provider.id, {
        name: name.trim(),
        ...(provider.presetId != null ? { presetId: provider.presetId } : {}),
        // Left empty, the key is not sent and the server keeps the one it has.
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
        agents,
      })
      .then((saved) => {
        onSaved(saved);
        onClose();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog title={`${provider.name} · 连接设置`} onClose={onClose}>
      <form
        className="flex flex-col gap-md px-lg py-md"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="名字">
          <input value={name} onChange={(event) => setName(event.target.value)} className={INPUT_CLASS} />
        </Field>
        <Field label="API key" hint={provider.hasKey ? "已经存了一个。留空就不改。" : "现在没有 key。"}>
          <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider.hasKey ? "••••••••" : "粘贴 key"} className={cn(INPUT_CLASS, "font-mono")} />
        </Field>
        {addressed.map((agent) => (
          <Field key={agent} label={choosable ? "接入地址" : `${agentLabel(agent)} 的接入地址`}>
            <input value={urls[agent] ?? ""} onChange={(event) => setUrls((current) => ({ ...current, [agent]: event.target.value }))} spellCheck={false} className={cn(INPUT_CLASS, "font-mono")} />
          </Field>
        ))}
        {choosable && usable.includes("claude-code") && (
          <Field label={`${agentLabel("claude-code")} 用的地址（可选）`} hint="Claude Code 只说 Anthropic 协议。同一个服务要是也有 Anthropic 兼容的地址，填在这里它就也能用。">
            <input value={claudeBaseURL} onChange={(event) => setClaudeBaseURL(event.target.value)} placeholder="https://example.com/anthropic" spellCheck={false} className={cn(INPUT_CLASS, "font-mono")} />
          </Field>
        )}
        {choosable && usable.includes("codex") && (
          <div className="flex items-start gap-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-2xs">
              <span className={FIELD_LABEL}>{agentLabel("codex")} 也用它</span>
              <span className="text-fg-faint text-sm">Codex 只说 OpenAI 的 Responses 协议（上面的地址加 /responses）。这个服务支持才打开；只有聊天补全接口的服务，Codex 用不了。</span>
            </div>
            <Switch checked={codex} onChange={setCodex} label={`${agentLabel("codex")} 也用这个提供商`} />
          </div>
        )}
        {error != null && <p className="text-danger text-sm">{error}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" onClick={onClose} className={BUTTON_GHOST}>
            取消
          </button>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmActionDialog({ title, message, confirmLabel, onConfirm, onClose }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={() => { if (!busy) onClose(); }}>
      <div className="flex flex-col gap-md px-lg py-md">
        <p className="text-fg-muted text-md">{message}</p>
        {error != null && <p className="text-danger text-sm">{error}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" disabled={busy} onClick={onClose} className={BUTTON_GHOST}>取消</button>
          <button type="button" disabled={busy} onClick={() => void confirm()} className={cn(BUTTON_GHOST, "text-danger hover:bg-danger-bg hover:text-danger")}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * One row of「已添加」that can be dragged by its grip — only by the grip, so the
 * row's buttons still click. The grip sits in the row's left padding and shows
 * on hover, so the rows line up with the GitHub row above them.
 */
function DraggableRow({ value, draggable, onDrop, children }: { value: string; draggable: boolean; onDrop: () => void; children: ReactNode }) {
  const controls = useDragControls();
  return (
    <Reorder.Item as="div" value={value} dragListener={false} dragControls={controls} onDragEnd={onDrop} className="group relative bg-bg" whileDrag={{ zIndex: 1 }}>
      {draggable && (
        <span
          aria-hidden
          onPointerDown={(event) => controls.start(event)}
          className="absolute inset-y-0 left-0 grid w-md cursor-grab touch-none place-items-center text-fg-faint opacity-0 hover:text-fg-muted active:cursor-grabbing group-hover:opacity-100"
        >
          <GripVertical className="size-md" />
        </span>
      )}
      {children}
    </Reorder.Item>
  );
}

type Open =
  | { kind: "subscription-models"; id: SubscriptionId }
  | { kind: "connect"; entry: CatalogProviderSummary }
  | { kind: "custom" }
  | { kind: "edit"; provider: RedactedProviderConfig }
  | { kind: "models"; providerId: string }
  | { kind: "disconnect"; providerId: string };

const ACCOUNT_KINDS: readonly AccountKind[] = ["claude", "codex", "github"];

/**
 * 模型提供商: what is connected — every account that brings models, one row
 * each, and the providers — and one 添加 menu for the rest: another account
 * first, then 自定义, then the whole catalog. The catalog is not ours —
 * it is the models.dev list the server caches — so a new vendor shows up
 * without a release.
 */
export function ProvidersPage({
  onManageAccount,
  client,
  engines,
  onChanged,
}: {
  /** 管理账号: the account's own page. */
  onManageAccount?: (accountId: string) => void;
  client: ApiClient;
  /** 引擎能力表: which agents can take a provider at all, and what they are called. */
  engines: EngineDescriptor[];
  /** Something about the models on offer changed; the model pickers reload. */
  /** After a provider or its models changed, for a caller whose lists were loaded once. */
  onChanged?: (() => void) | undefined;
}) {
  const toast = useToast();
  const login = useAccountLogin();
  const [providers, setProviders] = useState<RedactedProviderConfig[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionAccount[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [loadError, setLoadError] = useState<string>();
  const [addedReady, setAddedReady] = useState(false);
  const [open, setOpen] = useState<Open>();
  const [reloading, setReloading] = useState(false);
  /** 提供商排序 as last dragged; `Settings.providerOrder`. */
  const [order, setOrder] = useState<string[]>();
  const orderRef = useRef(order);
  orderRef.current = order;

  const subscriptionRequest = useRef(0);
  useEffect(() => {
    if (!addedReady) return;
    return onAccountsChanged(client, () => {
      const ticket = ++subscriptionRequest.current;
      void client.listSubscriptions().then(next => {
        if (ticket === subscriptionRequest.current) setSubscriptions(next);
      }).catch(() => {});
    });
  }, [client, addedReady]);

  const usable = useMemo(() => engines.filter((engine) => engine.capabilities.customProviders).map((engine) => engine.id as ProviderAgent), [engines]);
  const unusable = engines.filter((engine) => !engine.capabilities.customProviders);
  const agentLabel = useCallback<AgentLabel>((agent) => engines.find((engine) => engine.id === agent)?.label ?? agent, [engines]);

  useEffect(() => {
    let active = true;
    setAddedReady(false);
    setProviders([]);
    setSubscriptions([]);
    setOrder(undefined);
    setLoadError(undefined);
    // The added rows and their saved order must land together; otherwise the
    // providers appear first and the subscription rows jump ahead of them.
    void Promise.allSettled([client.listProviders(), client.listSubscriptions(), client.getSettings(), client.getProviderCatalog()]).then(([providerResult, subscriptionResult, settingsResult, catalogResult]) => {
      if (!active) return;
      if (providerResult.status === "fulfilled") setProviders(providerResult.value);
      if (subscriptionResult.status === "fulfilled") setSubscriptions(subscriptionResult.value);
      if (settingsResult.status === "fulfilled") setOrder(settingsResult.value.providerOrder);
      if (catalogResult.status === "fulfilled") setCatalog(catalogResult.value);
      const failure = [providerResult, subscriptionResult, settingsResult, catalogResult].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") setLoadError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
      setAddedReady(true);
    });
    return () => { active = false; };
  }, [client]);

  const added = useMemo(() => orderAdded(subscriptions, providers, order), [subscriptions, providers, order]);

  /** A drag is over: the order it left becomes the model picker's. */
  const saveOrder = () => {
    const next = orderRef.current;
    if (next == null) return;
    void client
      .putProviderOrder(next)
      .then(() => onChanged?.())
      .catch((cause: Error) => toast(cause.message));
  };

  const putSubscription = (next: SubscriptionAccount) => {
    setSubscriptions((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
    onChanged?.();
  };

  /** Reads the logins again; `refresh` also re-asks the vendors for their model lists. */
  const reloadSubscriptions = (refresh: boolean) => {
    const ticket = ++subscriptionRequest.current;
    return client.listSubscriptions(refresh).then((next) => {
      if (ticket === subscriptionRequest.current) setSubscriptions(next);
      onChanged?.();
      return next;
    });
  };

  const put = (next: RedactedProviderConfig) => {
    setProviders((current) => (current.some((entry) => entry.id === next.id) ? current.map((entry) => (entry.id === next.id ? next : entry)) : [...current, next]));
    onChanged?.();
  };

  const disconnect = async (provider: RedactedProviderConfig) => {
    await client.deleteProvider(provider.id);
    setProviders((current) => current.filter((entry) => entry.id !== provider.id));
    onChanged?.();
    toast(`已断开 ${provider.name}`);
  };

  const reloadCatalog = () => {
    setReloading(true);
    void client
      .getProviderCatalog(true)
      .then(setCatalog)
      .catch((cause: Error) => toast(cause.message))
      .finally(() => setReloading(false));
  };

  const connectedCatalogIds = useMemo(() => new Set(providers.flatMap((provider) => (provider.presetId != null ? [provider.presetId] : []))), [providers]);
  const pickCatalog = useCallback((entry: CatalogProviderSummary) => setOpen({ kind: "connect", entry }), []);
  const modelsOf = open?.kind === "models" ? providers.find((provider) => provider.id === open.providerId) : undefined;
  const disconnectOf = open?.kind === "disconnect" ? providers.find((provider) => provider.id === open.providerId) : undefined;
  const subscriptionOf = (id: SubscriptionId) => subscriptions.find((account) => account.id === id);
  const subscriptionModelsOf = open?.kind === "subscription-models" ? subscriptionOf(open.id) : undefined;
  const close = () => setOpen(undefined);

  /** 添加: another account, then 自定义 and the catalog. What is picked opens its own dialog. */
  const addMenu = (closeMenu: () => void): CascadeNode[] => {
    const choose = (next: Open) => () => {
      closeMenu();
      setOpen(next);
    };
    const connectable = catalog == null ? undefined : connectableCatalog(catalog.providers).length;
    return [
      // The host's accounts are signed in to on the host.
      ...(client.remoteSession ? [] : ACCOUNT_KINDS.map((kind) => ({
        key: kind,
        label: `${ACCOUNT_NAMES[kind]} 账号`,
        icon: <AccountLogo kind={kind} />,
        onPick: () => {
          closeMenu();
          login({ kind });
        },
      }))),
      { key: "custom", label: "自定义", icon: <Server className="size-md flex-none" />, separated: true, onPick: choose({ kind: "custom" }) },
      {
        key: "catalog",
        label: connectable == null ? "更多提供商" : `更多 ${connectable} 个提供商`,
        icon: <LayoutGrid className="size-md flex-none" />,
        content: (
          <CatalogMenu
            catalog={catalog}
            connectedIds={connectedCatalogIds}
            reloading={reloading}
            onReload={reloadCatalog}
            onPick={(entry) => {
              closeMenu();
              pickCatalog(entry);
            }}
          />
        ),
      },
    ];
  };

  return (
    <SettingsPage title="模型与提供商">
      <SettingsGroup
        title="已添加"
        actions={
          <Popover
            align="end"
            ariaLabel="添加提供商"
            trigger={(props) => (
              <button {...props} type="button" className={BUTTON_SECONDARY}>
                <Plus className="size-md" />
                添加
              </button>
            )}
          >
            {(closeMenu) => <CascadeLevel nodes={addMenu(closeMenu)} />}
          </Popover>
        }
      >
        {!addedReady && <SettingsEmpty>正在读取订阅和提供商…</SettingsEmpty>}
        {addedReady && added.length > 0 && (
          <Reorder.Group as="div" axis="y" values={added.map((entry) => entry.key)} onReorder={(keys: string[]) => setOrder((current) => withShownOrder(current, keys))} className="flex flex-col divide-y divide-border">
            {added.map(({ key, account, provider }) => (
              <DraggableRow key={key} value={key} draggable={added.length > 1} onDrop={saveOrder}>
                {account != null ? (
                  <SettingsRow
                    leading={
                      <span className="grid size-xl flex-none place-items-center rounded-md border border-border bg-bg-elevated text-fg-muted">
                        <AccountLogo kind={account.kind} />
                      </span>
                    }
                    title={
                      <>
                        <span className="truncate">{account.name}</span>
                        <Tag>订阅</Tag>
                      </>
                    }
                    help={[describeSubscription(account), `已打开的模型：${summarizeSubscription(account, agentLabel)}`].filter((part) => part != null).join(" · ")}
                  >
                    <button type="button" onClick={() => setOpen({ kind: "subscription-models", id: account.id })} className={BUTTON_SECONDARY}>
                      选模型
                    </button>
                    {onManageAccount != null && <button type="button" onClick={() => onManageAccount(account.accountId)} className={BUTTON_GHOST}>管理账号</button>}
                  </SettingsRow>
                ) : (
                  <SettingsRow
                    leading={<LetterAvatar name={provider.name} />}
                    title={
                      <>
                        <span className="truncate">{provider.name}</span>
                        {provider.presetId == null && <Tag>自定义</Tag>}
                        {!provider.hasKey && <Tag>无 key</Tag>}
                      </>
                    }
                    help={`已打开的模型：${summarizeEnabled(provider, agentLabel)}`}
                  >
                    <button type="button" onClick={() => setOpen({ kind: "models", providerId: provider.id })} className={BUTTON_SECONDARY}>
                      选模型
                    </button>
                    <button type="button" onClick={() => setOpen({ kind: "edit", provider })} className={BUTTON_GHOST}>
                      连接设置
                    </button>
                    <button type="button" onClick={() => setOpen({ kind: "disconnect", providerId: provider.id })} className={cn(BUTTON_GHOST, "hover:bg-danger-bg hover:text-danger")}>
                      断开
                    </button>
                  </SettingsRow>
                )}
              </DraggableRow>
            ))}
          </Reorder.Group>
        )}
        {addedReady && added.length === 0 && <SettingsEmpty>还没有添加任何提供商。</SettingsEmpty>}
      </SettingsGroup>

      {unusable.length > 0 && <p className="text-fg-faint text-sm">{unusable.map((engine) => engine.label).join("、")} 只能跑在它自己的订阅上，接不了要 key 的提供商。</p>}
      {loadError != null && <p className="text-danger text-sm">{loadError}</p>}

      {disconnectOf != null && (
        <ConfirmActionDialog
          title={`断开 ${disconnectOf.name}`}
          message={`断开后会删除 ${disconnectOf.name} 的连接设置、已保存的 API key 和模型开关；重新连接需要重新填写 key。`}
          confirmLabel="断开"
          onConfirm={() => disconnect(disconnectOf)}
          onClose={close}
        />
      )}

      {subscriptionModelsOf != null && (
        <Dialog title={`${subscriptionModelsOf.name} · 选模型`} onClose={close} wide>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SubscriptionTable client={client} account={subscriptionModelsOf} agentLabel={agentLabel} onAccount={putSubscription} onReload={() => reloadSubscriptions(true).then(() => undefined)} />
          </div>
          <div className="flex justify-end border-border border-t px-lg py-sm">
            <button type="button" onClick={close} className={BUTTON_PRIMARY}>
              完成
            </button>
          </div>
        </Dialog>
      )}
      {open?.kind === "connect" && (
        <ConnectDialog
          client={client}
          entry={open.entry}
          usable={usable}
          agentLabel={agentLabel}
          onConnected={(provider) => {
            put(provider);
            toast(`已连接 ${provider.name}`);
          }}
          onProvider={put}
          onClose={close}
        />
      )}
      {open?.kind === "custom" && (
        <CustomDialog
          client={client}
          usable={usable}
          agentLabel={agentLabel}
          onConnected={(provider) => {
            put(provider);
            toast(`已连接 ${provider.name}`);
          }}
          onProvider={put}
          onClose={close}
        />
      )}
      {open?.kind === "edit" && <EditDialog client={client} provider={open.provider} usable={usable} agentLabel={agentLabel} onSaved={put} onClose={close} />}
      {modelsOf != null && (
        <Dialog title={`${modelsOf.name} · 选模型`} onClose={close} wide>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ModelTable client={client} provider={modelsOf} agentLabel={agentLabel} availableAgents={usable} onProvider={put} />
          </div>
          <div className="flex justify-end border-border border-t px-lg py-sm">
            <button type="button" onClick={close} className={BUTTON_PRIMARY}>
              完成
            </button>
          </div>
        </Dialog>
      )}
    </SettingsPage>
  );
}
