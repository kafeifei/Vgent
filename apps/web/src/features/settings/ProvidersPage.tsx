import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Plus, Search } from "lucide-react";
import { ApiError, type ApiClient, type ProviderCatalog } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { CatalogProviderSummary, EngineDescriptor, ProviderAgent, ProviderModel, RedactedProviderConfig, SubscriptionAccount, SubscriptionId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_SECONDARY, Dialog, LetterAvatar, SettingsEmpty, SettingsGroup, SettingsPage, SettingsRow, Switch, Tag } from "./layout";
import { ModelTable } from "./ModelTable";
import { AGENT_ORDER, EMPTY_CUSTOM_FORM, agentsOf, connectInput, customInput, describeSubscription, filterCatalog, isSignedIn, summarizeEnabled, summarizeSubscription, withAgentChoices, type CustomForm } from "./providerModels";
import { SubscriptionTable } from "./SubscriptionTable";
import { INPUT_CLASS, PILL, PILL_SELECTED } from "./styles";

type AgentLabel = (agent: ProviderAgent) => string;

const FIELD_LABEL = "text-fg-muted text-xs";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2xs">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {hint != null && <span className="text-fg-faint text-xs">{hint}</span>}
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
        <p className="border-border border-b px-lg py-xs text-fg-faint text-xs">已连接。打开哪个 agent 的开关，模型就出现在它的模型选择器里；之后点这家的「模型」随时能改。</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ModelTable
            client={client}
            provider={connected.provider}
            agentLabel={agentLabel}
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
        <p className="text-fg-faint text-xs">
          {servedAgents(entry, usable, agentLabel)} 能用 · 目录里有 {entry.modelCount} 个模型 · 通过 <span className="font-mono">{entry.npm}</span> 接入
          {entry.docsUrl != null && (
            <>
              {" · "}
              <a href={entry.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-3xs text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                文档
                <ExternalLink className="size-xs" />
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
        {error != null && <p className="text-danger text-xs">{error}</p>}
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
        <p className="border-border border-b px-lg py-xs text-fg-faint text-xs">已连接。模型清单是向这个地址现拉的；拉不到就在底下手动加模型 id。</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ModelTable
            client={client}
            provider={connected}
            agentLabel={agentLabel}
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
        <p className="text-fg-faint text-xs">公司网关、自己搭的服务、目录里没有的厂商：只要它说 OpenAI 或 Anthropic 的协议就能接。</p>
        <Field label="名字">
          <input autoFocus value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="比如：公司网关" className={INPUT_CLASS} />
        </Field>
        <div className="flex flex-col gap-2xs">
          <span className={FIELD_LABEL}>协议</span>
          <div className="flex gap-2xs">
            {(
              [
                ["openai-compatible", "OpenAI 兼容"],
                ["anthropic", "Anthropic 兼容"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={form.protocol === id} onClick={() => set({ protocol: id })} className={cn(PILL, form.protocol === id && PILL_SELECTED)}>
                {label}
              </button>
            ))}
          </div>
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
              <span className="text-fg-faint text-xs">Codex 只说 OpenAI 的 Responses 协议（上面的地址加 /responses）。这个服务支持才打开；只有聊天补全接口的服务，Codex 用不了。</span>
            </div>
            <Switch checked={form.codexResponses} onChange={(on) => set({ codexResponses: on })} label={`${agentLabel("codex")} 也用这个提供商`} />
          </div>
        )}
        <Field label="API key" hint="没有 key 的本机服务可以留空。">
          <input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => set({ apiKey: event.target.value })} placeholder="粘贴 key" className={cn(INPUT_CLASS, "font-mono")} />
        </Field>
        {error != null && <p className="text-danger text-xs">{error}</p>}
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

/** 查看全部: the whole catalog behind a search box. What this build cannot connect is listed too, with the reason. */
function BrowseDialog({
  catalog,
  connectedIds,
  usable,
  agentLabel,
  onPick,
  onClose,
}: {
  catalog: ProviderCatalog;
  connectedIds: ReadonlySet<string>;
  usable: readonly ProviderAgent[];
  agentLabel: AgentLabel;
  onPick: (entry: CatalogProviderSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const matching = useMemo(
    () => filterCatalog(catalog.providers, query).sort((a, b) => Number(a.unsupported != null) - Number(b.unsupported != null) || a.name.localeCompare(b.name)),
    [catalog.providers, query],
  );

  return (
    <Dialog title={`全部提供商 · ${catalog.providers.length}`} onClose={onClose} wide>
      <div className="flex items-center gap-xs border-border border-b px-lg py-xs">
        <Search className="size-md flex-none text-fg-faint" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提供商" spellCheck={false} className="h-xl min-w-0 flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-faint" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto">
        {matching.map((entry) => {
          const connected = connectedIds.has(entry.id);
          return (
            <SettingsRow
              key={entry.id}
              leading={<LetterAvatar name={entry.name} />}
              title={
                <>
                  <span className="truncate">{entry.name}</span>
                  {connected && <Tag>已连接</Tag>}
                </>
              }
              help={entry.unsupported ?? `${servedAgents(entry, usable, agentLabel)} · ${entry.modelCount} 个模型`}
              className="px-lg"
            >
              <button type="button" disabled={entry.unsupported != null} onClick={() => onPick(entry)} className={BUTTON_SECONDARY}>
                <Plus className="size-xs" />
                {connected ? "再连一个" : "连接"}
              </button>
            </SettingsRow>
          );
        })}
        {matching.length === 0 && <SettingsEmpty>没有匹配「{query}」的提供商。目录里没有的，用「自定义」接。</SettingsEmpty>}
      </div>
    </Dialog>
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
              <span className="text-fg-faint text-xs">Codex 只说 OpenAI 的 Responses 协议（上面的地址加 /responses）。这个服务支持才打开；只有聊天补全接口的服务，Codex 用不了。</span>
            </div>
            <Switch checked={codex} onChange={setCodex} label={`${agentLabel("codex")} 也用这个提供商`} />
          </div>
        )}
        {error != null && <p className="text-danger text-xs">{error}</p>}
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

/**
 * A subscription has no key to paste: it is signed in to with the vendor's own
 * CLI, in a terminal. This says which command, and looks again when asked.
 */
function LoginDialog({ account, onRecheck, onClose }: { account: SubscriptionAccount; onRecheck: () => Promise<boolean>; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string>();

  const copy = () => {
    void navigator.clipboard
      ?.writeText(account.loginCommand)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  const recheck = () => {
    setChecking(true);
    setNote(undefined);
    void onRecheck()
      .then((signedIn) => {
        if (signedIn) onClose();
        else setNote("还是没查到登录。登录完成后再点一次。");
      })
      .catch((cause: Error) => setNote(cause.message))
      .finally(() => setChecking(false));
  };

  return (
    <Dialog title={`登录 ${account.name}`} onClose={onClose}>
      <div className="flex flex-col gap-md px-lg py-md">
        <p className="text-fg-muted text-sm">订阅不用 key。在终端里跑下面这条命令，按它的提示在浏览器里登录；登录存在它自己那里，Vgent 不保存也看不到。</p>
        <div className="flex items-center gap-xs rounded-md border border-border bg-bg-inset px-sm py-xs">
          <code className="min-w-0 flex-1 truncate font-mono text-fg text-sm">{account.loginCommand}</code>
          <button type="button" onClick={copy} className={BUTTON_GHOST}>
            {copied ? <Check className="size-xs" /> : <Copy className="size-xs" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        {account.loggedIn == null && <p className="text-fg-faint text-xs">这台机器上没找到它的命令行工具，得先装上。</p>}
        {account.note != null && <p className="text-fg-faint text-xs">{account.note}</p>}
        {note != null && <p className="text-danger text-xs">{note}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" onClick={onClose} className={BUTTON_GHOST}>
            关闭
          </button>
          <button type="button" disabled={checking} onClick={recheck} className={BUTTON_PRIMARY}>
            {checking ? "检查中…" : "我登录好了，重新检查"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

type Open =
  | { kind: "login"; id: SubscriptionId }
  | { kind: "subscription-models"; id: SubscriptionId }
  | { kind: "connect"; entry: CatalogProviderSummary }
  | { kind: "custom" }
  | { kind: "browse" }
  | { kind: "edit"; provider: RedactedProviderConfig }
  | { kind: "models"; providerId: string };

/**
 * 模型提供商: what is connected, the popular ones a click away, and everything
 * else behind 查看全部. The list of providers is not ours — it is the models.dev
 * catalog the server caches — so a new vendor shows up without a release.
 */
export function ProvidersPage({
  client,
  engines,
  onChanged,
}: {
  client: ApiClient;
  /** 引擎能力表: which agents can take a provider at all, and what they are called. */
  engines: EngineDescriptor[];
  /** Something about the models on offer changed; the model pickers reload. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [providers, setProviders] = useState<RedactedProviderConfig[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionAccount[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [loadError, setLoadError] = useState<string>();
  const [open, setOpen] = useState<Open>();
  const [reloading, setReloading] = useState(false);

  const usable = useMemo(() => engines.filter((engine) => engine.capabilities.customProviders).map((engine) => engine.id as ProviderAgent), [engines]);
  const unusable = engines.filter((engine) => !engine.capabilities.customProviders);
  const agentLabel = useCallback<AgentLabel>((agent) => engines.find((engine) => engine.id === agent)?.label ?? agent, [engines]);

  useEffect(() => {
    void client
      .listProviders()
      .then(setProviders)
      .catch((cause: Error) => setLoadError(cause.message));
    void client
      .getProviderCatalog()
      .then(setCatalog)
      .catch((cause: Error) => setLoadError(cause.message));
    void client
      .listSubscriptions()
      .then(setSubscriptions)
      .catch((cause: Error) => setLoadError(cause.message));
  }, [client]);

  const putSubscription = (next: SubscriptionAccount) => {
    setSubscriptions((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
    onChanged();
  };

  /** Reads the logins again; `refresh` also re-asks the vendors for their model lists. */
  const reloadSubscriptions = (refresh: boolean) =>
    client.listSubscriptions(refresh).then((next) => {
      setSubscriptions(next);
      onChanged();
      return next;
    });

  const put = (next: RedactedProviderConfig) => {
    setProviders((current) => (current.some((entry) => entry.id === next.id) ? current.map((entry) => (entry.id === next.id ? next : entry)) : [...current, next]));
    onChanged();
  };

  const disconnect = (provider: RedactedProviderConfig) => {
    void client
      .deleteProvider(provider.id)
      .then(() => {
        setProviders((current) => current.filter((entry) => entry.id !== provider.id));
        onChanged();
        toast(`已断开 ${provider.name}`);
      })
      .catch((cause: Error) => toast(cause.message));
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
  const popular = useMemo(
    () => (catalog?.popular ?? []).flatMap((id) => catalog?.providers.find((entry) => entry.id === id) ?? []).filter((entry) => !connectedCatalogIds.has(entry.id)),
    [catalog, connectedCatalogIds],
  );
  const modelsOf = open?.kind === "models" ? providers.find((provider) => provider.id === open.providerId) : undefined;
  const signedIn = subscriptions.filter(isSignedIn);
  const signedOut = subscriptions.filter((account) => !isSignedIn(account));
  const subscriptionOf = (id: SubscriptionId) => subscriptions.find((account) => account.id === id);
  const loginOf = open?.kind === "login" ? subscriptionOf(open.id) : undefined;
  const subscriptionModelsOf = open?.kind === "subscription-models" ? subscriptionOf(open.id) : undefined;
  const close = () => setOpen(undefined);

  return (
    <SettingsPage title="模型提供商" description="Claude 和 Codex 的订阅用它们自己的登录，不用 key；别的填一次 key 接一家。接上之后，点每一家的「模型」决定每个 agent 用它的哪些。">
      <SettingsGroup title="已连接">
        {signedIn.map((account) => (
          <SettingsRow
            key={account.id}
            leading={<LetterAvatar name={account.name} />}
            title={
              <>
                <span className="truncate">{account.name}</span>
                <Tag>订阅</Tag>
              </>
            }
            help={`${describeSubscription(account, agentLabel)} · 已打开的模型：${summarizeSubscription(account, agentLabel)}`}
          >
            <button type="button" onClick={() => setOpen({ kind: "subscription-models", id: account.id })} className={BUTTON_SECONDARY}>
              选模型
            </button>
          </SettingsRow>
        ))}
        {providers.map((provider) => (
          <SettingsRow
            key={provider.id}
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
            <button type="button" onClick={() => disconnect(provider)} className={cn(BUTTON_GHOST, "hover:bg-danger-bg hover:text-danger")}>
              断开
            </button>
          </SettingsRow>
        ))}
        {providers.length === 0 && signedIn.length === 0 && <SettingsEmpty>还没有连接任何提供商。</SettingsEmpty>}
      </SettingsGroup>

      <SettingsGroup
        title="热门"
        note={
          catalog?.source === "builtin" ? (
            <>
              连不上 models.dev，这里只有随应用带的几家。
              <button type="button" disabled={reloading} onClick={reloadCatalog} className="ml-2xs text-fg-muted underline underline-offset-2 hover:text-fg">
                {reloading ? "重试中…" : "重试"}
              </button>
            </>
          ) : undefined
        }
      >
        {signedOut.map((account) => (
          <SettingsRow
            key={account.id}
            leading={<LetterAvatar name={account.name} />}
            title={
              <>
                <span className="truncate">{account.name}</span>
                <Tag>订阅</Tag>
              </>
            }
            help={describeSubscription(account, agentLabel)}
          >
            <button type="button" onClick={() => setOpen({ kind: "login", id: account.id })} className={BUTTON_SECONDARY}>
              登录
            </button>
          </SettingsRow>
        ))}
        {popular.map((entry) => (
          <SettingsRow key={entry.id} leading={<LetterAvatar name={entry.name} />} title={entry.name} help={`${servedAgents(entry, usable, agentLabel)} · ${entry.modelCount} 个模型`}>
            <button type="button" onClick={() => setOpen({ kind: "connect", entry })} className={BUTTON_SECONDARY}>
              <Plus className="size-xs" />
              连接
            </button>
          </SettingsRow>
        ))}
        <SettingsRow leading={<LetterAvatar name="+" />} title={<>自定义<Tag>OpenAI / Anthropic 兼容</Tag></>} help="公司网关、自己搭的服务、目录里没有的厂商。">
          <button type="button" onClick={() => setOpen({ kind: "custom" })} className={BUTTON_SECONDARY}>
            <Plus className="size-xs" />
            连接
          </button>
        </SettingsRow>
      </SettingsGroup>

      <button type="button" disabled={catalog == null} onClick={() => setOpen({ kind: "browse" })} className="w-fit text-brand text-sm hover:underline disabled:opacity-40">
        {catalog == null ? "正在读取提供商目录…" : `查看全部 ${catalog.providers.length} 个提供商`}
      </button>

      {unusable.length > 0 && <p className="text-fg-faint text-xs">{unusable.map((engine) => engine.label).join("、")} 只能跑在它自己的订阅上，接不了要 key 的提供商。</p>}
      {loadError != null && <p className="text-danger text-xs">{loadError}</p>}

      {loginOf != null && (
        <LoginDialog
          account={loginOf}
          onRecheck={() =>
            reloadSubscriptions(true).then((next) => {
              const now = next.find((account) => account.id === loginOf.id);
              if (now == null || !isSignedIn(now)) return false;
              toast(`已登录 ${now.name}`);
              return true;
            })
          }
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
      {open?.kind === "browse" && catalog != null && (
        <BrowseDialog catalog={catalog} connectedIds={connectedCatalogIds} usable={usable} agentLabel={agentLabel} onPick={(entry) => setOpen({ kind: "connect", entry })} onClose={close} />
      )}
      {open?.kind === "edit" && <EditDialog client={client} provider={open.provider} usable={usable} agentLabel={agentLabel} onSaved={put} onClose={close} />}
      {modelsOf != null && (
        <Dialog title={`${modelsOf.name} · 选模型`} onClose={close} wide>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ModelTable client={client} provider={modelsOf} agentLabel={agentLabel} onProvider={put} />
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
