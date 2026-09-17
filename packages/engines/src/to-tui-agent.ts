import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { Agent } from "ai";

/**
 * The shape `runAgentTUI` accepts (`AgentTUIAgent` in `@ai-sdk/tui`). Declared
 * against `ai` so engine packages do not have to depend on the terminal UI.
 */
export type TUIAgent = Agent<any, any, any, any>;

/**
 * `HarnessAgent` needs a session on every call; an AI SDK `Agent` does not take
 * one. This closure injects a single session for the lifetime of the wrapper,
 * which is what the harness terminal-UI docs prescribe. One session per engine
 * instance.
 */
export function toTUIAgent({
  agent,
  session,
}: {
  agent: HarnessAgent<any, any, any, any, any>;
  session: HarnessAgentSession;
}): TUIAgent {
  return {
    version: "agent-v1",
    id: agent.id,
    tools: agent.tools,
    generate(request: unknown) {
      return agent.generate({ ...(request as object), session } as Parameters<typeof agent.generate>[0]);
    },
    stream(request: unknown) {
      return agent.stream({ ...(request as object), session } as Parameters<typeof agent.stream>[0]);
    },
  } as TUIAgent;
}
