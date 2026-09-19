import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "@/lib/api";
import type { EngineDescriptor, ProviderAgent, RedactedProviderConfig, SubscriptionAccount } from "@/lib/types";
import { BUTTON_SECONDARY, SettingsEmpty, SettingsGroup, SettingsPage } from "./layout";
import { ModelTable } from "./ModelTable";
import { isSignedIn } from "./providerModels";
import { SubscriptionTable } from "./SubscriptionTable";

/**
 * 模型: the one table of 「每个 agent 用哪些模型」 — the models of every signed-in
 * subscription and every connected provider, a switch per agent. A provider's
 * models start off and are switched on; a subscription's come with the login,
 * so they start on and are switched off.
 */
export function ModelsPage({
  client,
  engines,
  onChanged,
  onOpenProviders,
}: {
  client: ApiClient;
  engines: EngineDescriptor[];
  onChanged: () => void;
  onOpenProviders: () => void;
}) {
  const [providers, setProviders] = useState<RedactedProviderConfig[]>();
  const [subscriptions, setSubscriptions] = useState<SubscriptionAccount[]>([]);
  const [error, setError] = useState<string>();
  const agentLabel = useCallback((agent: ProviderAgent) => engines.find((engine) => engine.id === agent)?.label ?? agent, [engines]);

  useEffect(() => {
    void client
      .listProviders()
      .then(setProviders)
      .catch((cause: Error) => setError(cause.message));
    void client
      .listSubscriptions()
      .then(setSubscriptions)
      .catch((cause: Error) => setError(cause.message));
  }, [client]);

  const putSubscription = (next: SubscriptionAccount) => {
    setSubscriptions((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
    onChanged();
  };
  const reloadSubscriptions = () =>
    client.listSubscriptions(true).then((next) => {
      setSubscriptions(next);
      onChanged();
    });
  const signedIn = subscriptions.filter(isSignedIn);

  const put = (next: RedactedProviderConfig) => {
    setProviders((current) => current?.map((entry) => (entry.id === next.id ? next : entry)));
    onChanged();
  };

  return (
    <SettingsPage title="模型" description="每个 agent 用哪些模型。开关开着，模型就出现在那个 agent 的模型选择器里。订阅带来的模型默认全开，提供商的模型要自己打开。">
      {signedIn.map((account) => (
        <SettingsGroup key={account.id} title={account.name}>
          <SubscriptionTable client={client} account={account} agentLabel={agentLabel} onAccount={putSubscription} onReload={reloadSubscriptions} />
        </SettingsGroup>
      ))}
      {providers?.map((provider) => (
        <SettingsGroup key={provider.id} title={provider.name}>
          <ModelTable client={client} provider={provider} agentLabel={agentLabel} onProvider={put} />
        </SettingsGroup>
      ))}
      {providers != null && providers.length === 0 && signedIn.length === 0 && (
        <SettingsGroup>
          <SettingsEmpty>
            <div className="flex items-center gap-sm">
              <span className="flex-1">还没有登录订阅，也没有连接提供商，所以这里没有可选的模型。</span>
              <button type="button" onClick={onOpenProviders} className={BUTTON_SECONDARY}>
                去连接
              </button>
            </div>
          </SettingsEmpty>
        </SettingsGroup>
      )}
      {error != null && <p className="text-danger text-xs">{error}</p>}
    </SettingsPage>
  );
}
