import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import type { CatalogProvider, ProviderAgent, ProviderModel, RedactedProviderConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, Switch } from "./layout";
import { agentsOf, filterModels, formatContext, isEnabled, modelRows, withModels } from "./providerModels";
import { INPUT_CLASS } from "./styles";

/** A provider like OpenRouter has hundreds of models; past this many rows the search box is the way in. */
const MAX_ROWS = 80;

/**
 * 「每个 agent 用哪些模型」 for one provider: a row per model, a switch per
 * agent. A switch saves on the click — there is nothing to submit. The rows are
 * the catalog's models plus whatever the provider's own listing returns.
 */
export function ModelTable({
  client,
  provider,
  agentLabel,
  initialDiscovered,
  onProvider,
}: {
  client: ApiClient;
  provider: RedactedProviderConfig;
  agentLabel: (agent: ProviderAgent) => string;
  /** A listing the caller already has (connecting checks the key with one), so it is not fetched twice. */
  initialDiscovered?: readonly ProviderModel[];
  onProvider: (next: RedactedProviderConfig) => void;
}) {
  const [catalog, setCatalog] = useState<CatalogProvider>();
  const [discovered, setDiscovered] = useState<readonly ProviderModel[]>(initialDiscovered ?? []);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();

  const agents = agentsOf(provider);
  const endpoint = provider.agents.vgent ?? provider.agents["claude-code"];

  const discover = useCallback(
    (quiet: boolean) => {
      if (endpoint == null) return;
      setBusy(true);
      if (!quiet) setNote(undefined);
      void client
        .discoverProviderModels({ providerId: provider.id, baseURL: endpoint.baseURL, protocol: endpoint.protocol })
        .then((models) => {
          setDiscovered(models);
          if (!quiet) setNote(`拉到 ${models.length} 个模型`);
        })
        .catch((cause: Error) => {
          if (!quiet) setNote(cause.message);
        })
        .finally(() => setBusy(false));
    },
    [client, endpoint, provider.id],
  );

  // The catalog's models for a catalog provider; the live listing for one that is in no catalog.
  const loadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (loadedFor.current === provider.id) return;
    loadedFor.current = provider.id;
    if (provider.presetId != null) {
      void client
        .getCatalogProvider(provider.presetId)
        .then((entry) => {
          setCatalog(entry);
          if (entry.models.length === 0 && initialDiscovered == null) discover(true);
        })
        .catch(() => {
          if (initialDiscovered == null) discover(true);
        });
    } else if (initialDiscovered == null) discover(true);
  }, [client, discover, initialDiscovered, provider.id, provider.presetId]);

  const rows = useMemo(() => modelRows(provider, catalog, discovered), [provider, catalog, discovered]);
  const matching = useMemo(() => filterModels(rows, query), [rows, query]);
  const shown = matching.slice(0, MAX_ROWS);

  // Switches are clicked faster than requests return. Each save is built from
  // the latest state rather than the last render, shown at once, and only the
  // answer to the newest request is taken as the server's word.
  const latest = useRef(provider);
  useEffect(() => {
    latest.current = provider;
  }, [provider]);
  const inFlight = useRef(0);

  const save = (agent: ProviderAgent, models: readonly ProviderModel[], on: boolean) => {
    setError(undefined);
    const input = withModels(latest.current, agent, models, on);
    const optimistic: RedactedProviderConfig = { ...latest.current, agents: input.agents };
    latest.current = optimistic;
    onProvider(optimistic);
    const ticket = ++inFlight.current;
    void client
      .updateProvider(provider.id, input)
      .then((saved) => {
        if (ticket === inFlight.current) onProvider(saved);
      })
      .catch((cause: Error) => {
        setError(`没存上：${cause.message}`);
        // The switches were moved ahead of the answer; put them back where the server has them.
        void client
          .listProviders()
          .then((all) => all.find((entry) => entry.id === provider.id))
          .then((stored) => stored != null && onProvider(stored))
          .catch(() => undefined);
      });
  };

  const addManual = () => {
    const id = manual.trim();
    if (id === "") return;
    setDiscovered((current) => (current.some((model) => model.id === id) ? current : [{ id }, ...current]));
    setQuery("");
    setManual("");
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-xs border-border border-b px-md py-xs">
        <Search className="size-md flex-none text-fg-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`搜索 ${rows.length} 个模型`}
          spellCheck={false}
          className="h-xl min-w-0 flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-faint"
        />
        {note != null && <span className="truncate text-fg-faint text-xs">{note}</span>}
        <button type="button" disabled={busy || endpoint == null} onClick={() => discover(false)} className={BUTTON_GHOST} title="向提供商要一次它现在的模型清单">
          <RefreshCw className={cn("size-xs", busy && "animate-spin")} />
          拉取模型
        </button>
      </div>

      <div className="flex items-center gap-sm border-border border-b bg-bg-inset px-md py-2xs text-fg-faint text-xs">
        <span className="flex-1">模型</span>
        {agents.map((agent) => {
          const allOn = matching.length > 0 && matching.every((model) => isEnabled(provider, agent, model.id));
          return (
            <button
              key={agent}
              type="button"
              disabled={matching.length === 0}
              onClick={() => save(agent, matching, !allOn)}
              title={allOn ? `${agentLabel(agent)}：关掉列出的这 ${matching.length} 个` : `${agentLabel(agent)}：打开列出的这 ${matching.length} 个`}
              className="w-[calc(var(--spacing-3xl)*2)] flex-none text-right hover:text-fg disabled:hover:text-fg-faint"
            >
              {agentLabel(agent)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col divide-y divide-border">
        {shown.map((model) => (
          <div key={model.id} className="flex items-center gap-sm px-md py-xs">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-fg text-sm">{model.label ?? model.id}</span>
              <span className="truncate font-mono text-2xs text-fg-faint">
                {model.id}
                {model.contextWindow != null && ` · ${formatContext(model.contextWindow)}`}
              </span>
            </div>
            {agents.map((agent) => (
              <div key={agent} className="flex w-[calc(var(--spacing-3xl)*2)] flex-none justify-end">
                <Switch
                  checked={isEnabled(provider, agent, model.id)}
                  onChange={(on) => save(agent, [model], on)}
                  label={`${agentLabel(agent)} 用 ${model.label ?? model.id}`}
                />
              </div>
            ))}
          </div>
        ))}
        {rows.length === 0 && <div className="px-md py-sm text-fg-faint text-sm">{busy ? "正在向提供商要模型清单…" : "还没有模型。点「拉取模型」，或者在下面手动加一个。"}</div>}
        {rows.length > 0 && matching.length === 0 && <div className="px-md py-sm text-fg-faint text-sm">没有匹配「{query}」的模型</div>}
        {matching.length > shown.length && <div className="px-md py-xs text-fg-faint text-xs">还有 {matching.length - shown.length} 个没列出来，用搜索缩小范围。</div>}
      </div>

      <div className="flex items-center gap-xs border-border border-t px-md py-xs">
        <input
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) addManual();
          }}
          placeholder="清单里没有？填模型 id 加一行"
          spellCheck={false}
          className={cn(INPUT_CLASS, "min-w-0 flex-1 font-mono")}
        />
        <button type="button" disabled={manual.trim() === ""} onClick={addManual} className={BUTTON_GHOST}>
          <Plus className="size-xs" />
          添加
        </button>
      </div>
      {error != null && <p className="border-border border-t px-md py-xs text-danger text-xs">{error}</p>}
    </div>
  );
}
