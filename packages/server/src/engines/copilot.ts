import type { CopilotProtocol } from "@vgent/providers";
import { COPILOT_SPEC_PREFIX, copilotProtocol, type CopilotModel } from "../accounts/copilot.js";
import type { CopilotEndpoint } from "../accounts/copilot-relay.js";
import { DEFAULT_ACCOUNT } from "../accounts/spec.js";
import type { AccountId } from "../accounts/types.js";
import { BadRequestError, EngineUnavailableError } from "../errors.js";
import type { EngineId } from "../types.js";
import type { EngineAccounts } from "./registry.js";

export type CopilotRoute = CopilotEndpoint & { model: CopilotModel; protocol: CopilotProtocol };

/**
 * How an engine that runs as its own process reaches a task's Copilot model:
 * through the relay, on the protocol it speaks. Undefined for a model that is
 * not Copilot's. Refused before anything starts when Copilot does not serve the
 * model on a protocol this engine speaks — the list never offers that pairing,
 * but a task can outlive the list it was picked from.
 */
export async function copilotRouteFor(
  engine: { id: EngineId; label: string },
  model: { accountId?: AccountId | undefined; spec: string | undefined },
  accounts: Pick<EngineAccounts, "copilot"> | undefined,
): Promise<CopilotRoute | undefined> {
  if (model.spec == null || !model.spec.startsWith(COPILOT_SPEC_PREFIX)) return undefined;
  if (accounts?.copilot == null) throw new EngineUnavailableError("GitHub Copilot 在这里不可用", "account_unavailable");
  const route = await accounts.copilot(model.accountId ?? DEFAULT_ACCOUNT.github, model.spec.slice(COPILOT_SPEC_PREFIX.length));
  const protocol = copilotProtocol(route.model, engine.id);
  if (protocol == null) throw new BadRequestError(`${engine.label} 跑不了 Copilot 的 ${route.model.name}：Copilot 没有按它的协议提供这个模型，请换一个引擎`, "invalid_model");
  return { ...route, protocol };
}
