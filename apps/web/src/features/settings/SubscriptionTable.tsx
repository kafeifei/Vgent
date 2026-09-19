import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import type { ProviderAgent, SubscriptionAccount, SubscriptionModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST } from "./layout";
import { ModelTableHeader, ModelTableRow } from "./ModelTable";
import { formatContext, withSubscriptionSwitch } from "./providerModels";

/**
 * 「每个 agent 用哪些模型」 for a subscription. The same table as a provider's,
 * with two differences that come from whose list it is: the models are the
 * vendor's (nothing to add by hand), and they all start on — a login brings its
 * models with it, the switches are for putting some away.
 */
export function SubscriptionTable({
  client,
  account,
  agentLabel,
  onAccount,
  onReload,
}: {
  client: ApiClient;
  account: SubscriptionAccount;
  agentLabel: (agent: ProviderAgent) => string;
  onAccount: (next: SubscriptionAccount) => void;
  /** Asks the vendor for its model list again. */
  onReload: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [reloading, setReloading] = useState(false);

  // Same discipline as the provider table: build each save from the latest
  // state, show it at once, and only take the newest request's answer.
  const latest = useRef(account);
  useEffect(() => {
    latest.current = account;
  }, [account]);
  const inFlight = useRef(0);

  const save = (agent: ProviderAgent, models: readonly SubscriptionModel[], enabled: boolean) => {
    setError(undefined);
    const rowIds = models.map((model) => model.id);
    const optimistic = { ...latest.current, models: withSubscriptionSwitch(latest.current.models, agent, rowIds, enabled) };
    latest.current = optimistic;
    onAccount(optimistic);
    const ticket = ++inFlight.current;
    void client
      .setSubscriptionModels(account.id, { agent, models: rowIds, enabled })
      .then((saved) => {
        if (ticket === inFlight.current) onAccount({ ...latest.current, models: saved });
      })
      .catch((cause: Error) => {
        setError(`没存上：${cause.message}`);
        void onReload().catch(() => undefined);
      });
  };

  const reload = () => {
    setReloading(true);
    void onReload()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setReloading(false));
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-xs border-border border-b px-md py-xs">
        <span className="min-w-0 flex-1 text-fg-faint text-xs">{account.warning ?? account.note ?? "模型清单来自这个登录；默认全开，不想在选择器里看到的关掉。"}</span>
        <button type="button" disabled={reloading} onClick={reload} className={BUTTON_GHOST} title="重新读一次它现在的模型清单">
          <RefreshCw className={cn("size-xs", reloading && "animate-spin")} />
          拉取模型
        </button>
      </div>
      <ModelTableHeader
        agents={account.agents}
        agentLabel={agentLabel}
        count={account.models.length}
        allOn={(agent) => account.models.every((model) => model.agents[agent]?.enabled !== false)}
        onToggleAll={(agent, on) => save(agent, account.models, on)}
      />
      <div className="flex flex-col divide-y divide-border">
        {account.models.map((model) => (
          <ModelTableRow
            key={model.id}
            label={model.label}
            detail={`${model.id}${model.contextWindow != null ? ` · ${formatContext(model.contextWindow)}` : ""}`}
            agents={account.agents}
            agentLabel={agentLabel}
            enabled={(agent) => model.agents[agent]?.enabled}
            onSwitch={(agent, on) => save(agent, [model], on)}
          />
        ))}
        {account.models.length === 0 && <div className="px-md py-sm text-fg-faint text-sm">没有读到模型。</div>}
      </div>
      {error != null && <p className="border-border border-t px-md py-xs text-danger text-xs">{error}</p>}
    </div>
  );
}
