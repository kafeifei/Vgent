import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "@/lib/api";
import type { EngineDescriptor, ProviderAgent, RedactedProviderConfig } from "@/lib/types";
import { BUTTON_SECONDARY, SettingsEmpty, SettingsGroup, SettingsPage } from "./layout";
import { ModelTable } from "./ModelTable";

/**
 * 模型: the one table of 「每个 agent 用哪些模型」 — every connected provider's
 * models, a switch per agent. What an agent gets from its own login (Claude
 * Code's, Codex's) is not listed here: that is not ours to turn on or off.
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
  const [error, setError] = useState<string>();
  const agentLabel = useCallback((agent: ProviderAgent) => engines.find((engine) => engine.id === agent)?.label ?? agent, [engines]);

  useEffect(() => {
    void client
      .listProviders()
      .then(setProviders)
      .catch((cause: Error) => setError(cause.message));
  }, [client]);

  const put = (next: RedactedProviderConfig) => {
    setProviders((current) => current?.map((entry) => (entry.id === next.id ? next : entry)));
    onChanged();
  };

  return (
    <SettingsPage title="模型" description="每个 agent 用哪些模型。打开开关，模型就出现在那个 agent 的模型选择器里；各 agent 凭自己登录得到的模型不在这里管。">
      {providers?.map((provider) => (
        <SettingsGroup key={provider.id} title={provider.name}>
          <ModelTable client={client} provider={provider} agentLabel={agentLabel} onProvider={put} />
        </SettingsGroup>
      ))}
      {providers != null && providers.length === 0 && (
        <SettingsGroup>
          <SettingsEmpty>
            <div className="flex items-center gap-sm">
              <span className="flex-1">还没有连接提供商，所以这里没有可选的模型。</span>
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
