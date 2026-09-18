import type { ProviderInputBody } from "@/lib/api";
import type { ProviderAgent, ProviderModel, ProviderPreset, ProviderProtocol, RedactedProviderConfig } from "@/lib/types";

/** One agent's block of the form: whether it is on, where it connects, and what the user can tick. */
export interface AgentForm {
  enabled: boolean;
  baseURL: string;
  protocol: ProviderProtocol;
  /** Everything offered: the preset's seed models, what was already ticked, and what 拉取 brought back. */
  candidates: ProviderModel[];
  /** Ids of the ticked candidates. */
  selected: string[];
}

export interface ProviderForm {
  /** Set when editing; a new provider's id is the server's to pick. */
  id?: string;
  name: string;
  presetId?: string;
  /** What the user typed this time. Empty while editing means「不改」, never「清掉」. */
  apiKey: string;
  /** Whether the server already holds a key for this provider. */
  hasKey: boolean;
  agents: Record<ProviderAgent, AgentForm>;
}

/** Claude Code speaks Anthropic Messages only; the in-house agent defaults to the more universal protocol. */
const DEFAULT_PROTOCOL: Record<ProviderAgent, ProviderProtocol> = {
  vgent: "openai-compatible",
  "claude-code": "anthropic",
  codex: "openai-compatible",
};

const AGENTS: readonly ProviderAgent[] = ["vgent", "claude-code", "codex"];

const emptyAgent = (agent: ProviderAgent): AgentForm => ({
  enabled: false,
  baseURL: "",
  protocol: DEFAULT_PROTOCOL[agent],
  candidates: [],
  selected: [],
});

const emptyAgents = (): ProviderForm["agents"] =>
  Object.fromEntries(AGENTS.map((agent) => [agent, emptyAgent(agent)])) as ProviderForm["agents"];

/** 自定义: nothing filled in. */
export function emptyProviderForm(): ProviderForm {
  return { name: "", apiKey: "", hasKey: false, agents: emptyAgents() };
}

/** A preset fills everything but the key, with every seed model ticked — one paste away from usable. */
export function formFromPreset(preset: ProviderPreset): ProviderForm {
  const agents = emptyAgents();
  for (const agent of AGENTS) {
    const config = preset.agents[agent];
    if (config == null) continue;
    agents[agent] = {
      enabled: true,
      baseURL: config.baseURL,
      protocol: config.protocol,
      candidates: config.models,
      selected: config.models.map((model) => model.id),
    };
  }
  return { name: preset.name, presetId: preset.id, apiKey: "", hasKey: false, agents };
}

/** Candidates in a stable order with no id twice; an earlier entry's label and window win. */
export function mergeCandidates(...lists: readonly (readonly ProviderModel[])[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const list of lists) {
    for (const model of list) {
      const known = byId.get(model.id);
      byId.set(model.id, known == null ? model : { ...model, ...known });
    }
  }
  return [...byId.values()];
}

/** Editing: what is stored, plus the preset's seeds as further candidates so an unticked one can be ticked back. */
export function formFromProvider(provider: RedactedProviderConfig, preset: ProviderPreset | undefined): ProviderForm {
  const agents = emptyAgents();
  for (const agent of AGENTS) {
    const config = provider.agents[agent];
    const seeds = preset?.agents[agent];
    if (config == null) {
      if (seeds != null) agents[agent] = { ...emptyAgent(agent), baseURL: seeds.baseURL, protocol: seeds.protocol, candidates: seeds.models };
      continue;
    }
    agents[agent] = {
      enabled: true,
      baseURL: config.baseURL,
      protocol: config.protocol,
      candidates: mergeCandidates(config.models, seeds?.models ?? []),
      selected: config.models.map((model) => model.id),
    };
  }
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.presetId != null ? { presetId: provider.presetId } : {}),
    apiKey: "",
    hasKey: provider.hasKey,
    agents,
  };
}

/** What 拉取 brought back, folded into an agent's candidates. Ticks are left exactly as they were. */
export function withDiscovered(form: AgentForm, discovered: readonly ProviderModel[]): AgentForm {
  return { ...form, candidates: mergeCandidates(form.candidates, discovered) };
}

export function toggleModel(form: AgentForm, modelId: string): AgentForm {
  const selected = form.selected.includes(modelId) ? form.selected.filter((id) => id !== modelId) : [...form.selected, modelId];
  return { ...form, selected };
}

/**
 * The request body, or the sentence that says why there is none yet. Only the
 * agents in `usable` are sent — an engine that cannot take a custom provider
 * has no block in the form and must not get a config by accident either.
 */
export function toProviderInput(form: ProviderForm, usable: readonly ProviderAgent[]): { input: ProviderInputBody } | { error: string } {
  const name = form.name.trim();
  if (name === "") return { error: "给提供商起个名字" };
  const agents: ProviderInputBody["agents"] = {};
  for (const agent of usable) {
    const block = form.agents[agent];
    if (!block.enabled) continue;
    const baseURL = block.baseURL.trim();
    if (baseURL === "") return { error: "已启用的 agent 需要填接入地址" };
    if (!/^https?:\/\//i.test(baseURL)) return { error: "接入地址要以 http:// 或 https:// 开头" };
    // Kept in candidate order, which is the order the picker will list them in.
    const models = block.candidates.filter((model) => block.selected.includes(model.id));
    if (models.length === 0) return { error: "已启用的 agent 至少勾选一个模型" };
    agents[agent] = { baseURL, protocol: block.protocol, models };
  }
  if (Object.keys(agents).length === 0) return { error: "至少启用一个 agent" };
  const apiKey = form.apiKey.trim();
  return {
    input: {
      name,
      ...(form.presetId != null ? { presetId: form.presetId } : {}),
      // Untouched while editing = absent = the server keeps what it has.
      ...(apiKey !== "" ? { apiKey } : {}),
      agents,
    },
  };
}

/** 「自研 2 · Claude Code 1」for a provider's row. */
export function summarizeAgents(provider: RedactedProviderConfig, labelOf: (agent: ProviderAgent) => string): string {
  return AGENTS.filter((agent) => provider.agents[agent] != null)
    .map((agent) => `${labelOf(agent)} ${provider.agents[agent]?.models.length ?? 0} 个模型`)
    .join(" · ");
}
