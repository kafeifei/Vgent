import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createClient } from "@/lib/api";
import type { ProviderAgent, RedactedProviderConfig, SubscriptionAccount } from "@/lib/types";
import { ModelTable, ModelTableHeader } from "./ModelTable";
import { SubscriptionTable } from "./SubscriptionTable";

const agents = ["vgent", "codex"] as const;
const agentLabel = (agent: ProviderAgent) => agent === "vgent" ? "Vgent" : "Codex";
const noop = () => {};
const client = createClient("test-token");
const switches = (html: string) => html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];

describe("model select-all switches", () => {
  it("renders a labeled switch for each engine with its own checked state", () => {
    const html = renderToStaticMarkup(<ModelTableHeader agents={agents} agentLabel={agentLabel} count={() => 3} allOn={agent => agent === "codex"} onToggleAll={noop} />);
    const controls = switches(html);
    expect(controls).toHaveLength(2);
    expect(controls[0]).toContain('aria-label="Vgent：全选匹配的 3 个模型"');
    expect(controls[0]).toContain('aria-checked="false"');
    expect(controls[1]).toContain('aria-label="Codex：全选匹配的 3 个模型"');
    expect(controls[1]).toContain('aria-checked="true"');
    expect(html.match(/<span>全选<\/span>/g)).toHaveLength(2);
  });

  it("disables an empty engine column even when every on an empty list returns true", () => {
    const html = renderToStaticMarkup(<ModelTableHeader agents={agents} agentLabel={agentLabel} count={agent => agent === "vgent" ? 0 : 2} allOn={() => true} onToggleAll={noop} />);
    const controls = switches(html);
    expect(controls[0]).toContain('aria-checked="false"');
    expect(controls[0]).toContain('disabled=""');
    expect(controls[1]).toContain('aria-checked="true"');
    expect(controls[1]).not.toContain('disabled=""');
  });

  it("covers the complete provider list, including matches past the rendering limit", () => {
    const models = Array.from({ length: 81 }, (_, i) => ({ id: `model-${i}` }));
    const provider: RedactedProviderConfig = {
      id: "custom", name: "Custom", hasKey: false,
      agents: { vgent: { protocol: "openai-compatible", baseURL: "https://example.test/v1", models: models.slice(0, 80) } },
    };
    const render = (current: RedactedProviderConfig) => renderToStaticMarkup(<ModelTable client={client} provider={current} initialDiscovered={models} agentLabel={agentLabel} onProvider={noop} />);
    const html = render(provider);
    expect(switches(html)).toHaveLength(81); // Header + 80 rendered rows.
    expect(switches(html)[0]).toContain('aria-label="Vgent：全选匹配的 81 个模型"');
    expect(switches(html)[0]).toContain('aria-checked="false"');
    expect(html).toContain("还有 1 个没列出来");
    const allOn: RedactedProviderConfig = { ...provider, agents: { vgent: { ...provider.agents.vgent!, models } } };
    expect(switches(render(allOn))[0]).toContain('aria-checked="true"');
  });

  it("counts only subscription models supported by each engine", () => {
    const account: SubscriptionAccount = {
      id: "codex-subscription", accountId: "codex", kind: "codex", name: "Codex", agents: [...agents],
      models: [
        { id: "both", label: "Both", agents: { vgent: { spec: "codex-subscription:both", enabled: true }, codex: { spec: "both", enabled: true } } },
        { id: "native-only", label: "Native only", agents: { codex: { spec: "native-only", enabled: false } } },
      ],
    };
    const render = (current: SubscriptionAccount) => renderToStaticMarkup(<SubscriptionTable client={client} account={current} agentLabel={agentLabel} onAccount={noop} onReload={async () => {}} />);
    const controls = switches(render(account));
    expect(controls[0]).toContain('aria-label="Vgent：全选匹配的 1 个模型"');
    expect(controls[0]).toContain('aria-checked="true"');
    expect(controls[1]).toContain('aria-label="Codex：全选匹配的 2 个模型"');
    expect(controls[1]).toContain('aria-checked="false"');
    const unavailable = switches(render({ ...account, models: account.models.slice(1) }));
    expect(unavailable[0]).toContain('disabled=""');
    expect(unavailable[0]).toContain('aria-checked="false"');
  });
});
