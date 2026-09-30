import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { sinceCompaction } from "./compact.js";

const say = (id: string, role: "user" | "assistant", text = id): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const marker = (id: string, keptFrom?: string): UIMessage => ({
  ...say(id, "user", `summary ${id}`),
  metadata: { compacted: { before: 2, at: "2026-09-30T00:00:00.000Z", ...(keptFrom != null ? { keptFrom } : {}) } },
});
const ids = (messages: UIMessage[]) => messages.map((message) => message.id);

describe("sinceCompaction", () => {
  it("is the whole history when nothing was compacted", () => {
    const history = [say("u1", "user"), say("a1", "assistant")];
    expect(sinceCompaction(history)).toEqual(history);
  });

  it("reads on from the latest summary: the kept turns, then what came after", () => {
    const history = [say("u1", "user"), say("a1", "assistant"), say("u2", "user"), say("a2", "assistant"), marker("m1", "u2"), say("u3", "user"), say("a3", "assistant")];
    expect(ids(sinceCompaction(history))).toEqual(["m1", "m1-ack", "u2", "a2", "u3", "a3"]);
  });

  it("answers the summary itself when the user would speak next", () => {
    expect(ids(sinceCompaction([say("u1", "user"), say("a1", "assistant"), marker("m1"), say("u2", "user")]))).toEqual(["m1", "m1-ack", "u2"]);
    expect(ids(sinceCompaction([say("u1", "user"), say("a1", "assistant"), marker("m1")]))).toEqual(["m1", "m1-ack"]);
  });

  it("reads an older build's summary, which replaced the history and came with its reply, as it is", () => {
    const history = [marker("m1"), say("ack", "assistant", "已了解摘要，继续。"), say("u2", "user"), say("a2", "assistant")];
    expect(ids(sinceCompaction(history))).toEqual(["m1", "ack", "u2", "a2"]);
  });

  it("leaves an earlier summary out of the turns a later one kept", () => {
    const history = [say("u1", "user"), say("a1", "assistant"), say("u2", "user"), marker("m1", "u2"), say("a2", "assistant"), marker("m2", "u2")];
    expect(ids(sinceCompaction(history))).toEqual(["m2", "m2-ack", "u2", "a2"]);
  });
});
