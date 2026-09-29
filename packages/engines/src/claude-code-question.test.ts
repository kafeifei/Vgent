import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBridge, type BridgeTurn } from "@ai-sdk/harness/bridge";
import * as claudeCodeAdapter from "@ai-sdk/harness-claude-code";
import { describe, expect, it } from "vitest";

/**
 * The patched bridge runtime (`patches/@ai-sdk__harness@1.0.121.patch`, bundled
 * the same way into the Claude Code bridge) must not let an expired question
 * swallow or mis-deliver a later answer. Drives the real `runBridge` over a
 * WebSocket with a scripted turn; no runtime, no login.
 */
describe("bridge tool-result requests withdrawn by an abort signal", () => {
  it("rejects the request and drops a late result instead of handing it to another request", async () => {
    const sameQuestion = (result: { toolResult?: { providerOptions?: Record<string, Record<string, unknown>> } }) =>
      result.toolResult?.providerOptions?.["claude-code"]?.nativeRequest === "Which color?";
    const seen: string[] = [];
    const notices: unknown[] = [];

    const bridge = await runBridge<{ type: "start" }>({
      bridgeType: "test",
      bridgeStateDir: await mkdtemp(join(tmpdir(), "vgent-bridge-test-")),
      port: 0,
      token: "test-token",
      onExit: () => {},
      onStart: async (_start, turn: BridgeTurn) => {
        const expiry = new AbortController();
        const expired = turn.requestToolResult({ toolCallId: "q1", matches: sameQuestion, abortSignal: expiry.signal });
        expiry.abort(new Error("hook timed out"));
        await expired.then(
          () => seen.push("q1 resolved"),
          (error: Error) => seen.push(`q1 rejected: ${error.message}`),
        );

        // The same question again, pending when q1's late answer arrives.
        const second = turn.requestToolResult({ toolCallId: "q2", matches: sameQuestion });
        turn.emit({ type: "raw", rawValue: "q1 expired" });
        seen.push(`q2 got ${String((await second).output)}`);

        // Nothing of q1's may have been buffered for a later request either.
        const third = turn.requestToolResult({ toolCallId: "q3", matches: sameQuestion });
        turn.emit({ type: "raw", rawValue: "q3 requested" });
        seen.push(`q3 got ${String((await third).output)}`);
        turn.emit({ type: "raw", rawValue: "done" });
      },
    });

    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/?agent_bridge_token=test-token`);
    const toolResult = (toolCallId: string, output: string) =>
      JSON.stringify({
        type: "tool-result",
        toolCallId,
        output,
        toolResult: {
          type: "tool-result",
          toolCallId,
          toolName: "askUserQuestions",
          output: { type: "text", value: output },
          providerOptions: { "claude-code": { nativeRequest: "Which color?" } },
        },
      });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("socket error")));
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; rawValue?: unknown };
          if (message.type === "bridge-hello") socket.send(JSON.stringify({ type: "start" }));
          if (message.type !== "raw") return;
          if (typeof message.rawValue === "object") notices.push(message.rawValue);
          if (message.rawValue === "q1 expired") {
            socket.send(toolResult("q1", "late Blue"));
            socket.send(toolResult("q2", "Red"));
          } else if (message.rawValue === "q3 requested") {
            socket.send(toolResult("q3", "Green"));
          } else if (message.rawValue === "done") {
            resolve();
          }
        });
      });
    } finally {
      socket.close();
      await bridge.close();
    }

    expect(seen).toEqual(["q1 rejected: hook timed out", "q2 got Red", "q3 got Green"]);
    // The host is told, so it can send the answer as the next turn.
    expect(notices).toEqual([{ type: "vgent-tool-result-expired", toolCallId: "q1" }]);
  });

  it("ships in the bundled Claude Code bridge, which is the copy that runs", async () => {
    const entry = createRequire(import.meta.url).resolve("@ai-sdk/harness-claude-code");
    const bridge = await readFile(join(dirname(entry), "bridge", "index.mjs"), "utf8");
    expect(bridge).toContain("expiredToolCallIds.add(request.toolCallId)");
    expect(bridge).toContain('rawValue: { type: "vgent-tool-result-expired", toolCallId: msg.toolCallId }');
    expect(bridge).toContain("timeout: resolveQuestionTimeoutSeconds(start.env)");
  });
});

/**
 * The adapter side of the same patch: a continuation whose bridge turn already
 * ended must not wait forever for events, and its answer must reach Claude as
 * the next turn. Drives the adapter's real session against a scripted channel.
 */
describe("Claude Code continuation of a turn the bridge already ended", () => {
  type Listener = (message: Record<string, unknown>) => void;
  class ScriptedChannel {
    sent: Array<Record<string, unknown>> = [];
    private listeners = new Map<string, Set<Listener>>();
    private buffered = new Map<string, Array<Record<string, unknown>>>();
    private closeHandlers = new Set<(code: number, reason: string) => void>();
    private closed = false;
    on(type: string, listener: Listener) {
      const set = this.listeners.get(type) ?? new Set();
      this.listeners.set(type, set);
      set.add(listener);
      // Like SandboxChannel: events that reached no listener wait for one.
      const waiting = this.buffered.get(type);
      this.buffered.delete(type);
      for (const message of waiting ?? []) listener(message);
      return () => { set.delete(listener); };
    }
    onClose(handler: (code: number, reason: string) => void) { this.closeHandlers.add(handler); }
    onReconnect() { return () => {}; }
    isClosed() { return this.closed; }
    send(message: Record<string, unknown>) {
      if (this.closed) throw new Error(`SandboxChannel: cannot send ${String(message.type)} — channel is closed.`);
      this.sent.push(message);
    }
    emit(...messages: Array<Record<string, unknown>>) {
      for (const message of messages) {
        const set = this.listeners.get(message.type as string);
        if (set == null || set.size === 0) {
          this.buffered.set(message.type as string, [...(this.buffered.get(message.type as string) ?? []), message]);
          continue;
        }
        for (const listener of [...set]) listener(message);
      }
    }
    close() {
      this.closed = true;
      for (const handler of this.closeHandlers) handler(1006, "reconnect failed");
    }
    starts() { return this.sent.filter((message) => message.type === "start"); }
  }

  type Control = {
    submitToolResult: (input: Record<string, unknown>) => Promise<void>;
    done: Promise<void>;
  };
  type Session = {
    doPromptTurn: (options: Record<string, unknown>) => Promise<Control>;
    doContinueTurn: (options: Record<string, unknown>) => Promise<Control>;
  };
  const createSession = (claudeCodeAdapter as unknown as {
    __createClaudeCodeSessionForTesting: (options: Record<string, unknown>) => Session;
  }).__createClaudeCodeSessionForTesting;

  const session = (channel: ScriptedChannel, { attach = false, bridgeTurnOpen = false } = {}) =>
    createSession({
      sessionId: "thread", channel, proc: undefined, isResume: attach, continueOnFirstPrompt: false,
      rerunContinue: false, bridgeTurnOpen, bridgePort: 1, bridgeToken: "token", permissionMode: "allow-all",
      sandbox: { readTextFile: async () => null, writeTextFile: async () => {}, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      sandboxHomeDir: "/tmp/home", supportsUserMessageResponses: () => false,
    });
  const turn = (seen: Array<Record<string, unknown>> = [], abortSignal?: AbortSignal) =>
    ({ model: "opus", skills: [], tools: [], prompt: { role: "user", content: "问吧" }, emit: (event: Record<string, unknown>) => seen.push(event), ...(abortSignal ? { abortSignal } : {}) });

  const nativeRequest = { questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] };
  const question = { type: "tool-call", toolCallId: "q1", toolName: "askUserQuestions", nativeName: "AskUserQuestion", input: "{}", providerExecuted: false, providerMetadata: { "claude-code": { nativeRequest } } };
  const answer = {
    toolCallId: "q1",
    output: { action: "answered", answers: { "question-1": { optionIds: ["option-2"] } } },
    toolResult: { type: "tool-result", toolCallId: "q1", toolName: "askUserQuestions", output: { type: "json", value: {} }, providerOptions: { "claude-code": { nativeRequest } } },
  };
  /** What Claude Code emits when its hook gives up: an error result, a fallback reply, the end of the turn. */
  const gaveUp = [
    { type: "tool-result", toolCallId: "q1", toolName: "askUserQuestions", result: "Error: PreToolUse hook did not respond before its timeout", isError: true },
    { type: "text-start", id: "fallback" },
    { type: "text-delta", id: "fallback", delta: "选项弹窗没弹出来" },
    { type: "text-end", id: "fallback" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, harnessMetadata: { "claude-code": { sessionId: "claude-1" } } },
  ];
  const nextTurn = [
    { type: "stream-start" },
    { type: "text-start", id: "reply" },
    { type: "text-delta", id: "reply", delta: "Blue" },
    { type: "text-end", id: "reply" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, harnessMetadata: { "claude-code": { sessionId: "claude-1" } } },
  ];
  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
  const settled = (promise: Promise<void>) => Promise.race([promise.then(() => "resolved", () => "rejected"), macrotask().then(() => "pending")]);
  const texts = (events: Array<Record<string, unknown>>) => events.filter((event) => event.type === "text-delta").map((event) => event.delta);

  it("answers a waiting question with a frame and nothing else", async () => {
    const channel = new ScriptedChannel();
    const claude = session(channel);
    await claude.doPromptTurn(turn());
    channel.emit(question);
    const control = await claude.doContinueTurn(turn());
    await control.submitToolResult(answer);
    await macrotask();
    expect(channel.sent.map((message) => message.type)).toEqual(["start", "tool-result"]);
    channel.emit(...nextTurn.slice(1));
    expect(await settled(control.done)).toBe("resolved");
  });

  it("sends an answer that came after Claude gave up as the next turn, and ends when that turn does", async () => {
    const channel = new ScriptedChannel();
    const claude = session(channel);
    await claude.doPromptTurn(turn());
    channel.emit(question, ...gaveUp);

    const seen: Array<Record<string, unknown>> = [];
    const control = await claude.doContinueTurn(turn(seen));
    await control.submitToolResult(answer);
    await macrotask();
    expect(channel.sent.filter((message) => message.type === "tool-result")).toEqual([]);
    expect(channel.starts()).toHaveLength(2);
    expect(channel.starts()[1]).toMatchObject({ resumeSessionId: "claude-1" });
    expect(channel.starts()[1]!.prompt).toContain("- Which color?: Blue");
    expect(await settled(control.done)).toBe("pending");

    channel.emit(...nextTurn);
    expect(await settled(control.done)).toBe("resolved");
    expect(texts(seen)).toEqual(["Blue"]);
  });

  it("resends an answer the bridge reports it dropped while Claude was still finishing", async () => {
    const channel = new ScriptedChannel();
    const claude = session(channel);
    await claude.doPromptTurn(turn());
    channel.emit(question);

    const seen: Array<Record<string, unknown>> = [];
    const control = await claude.doContinueTurn(turn(seen));
    await control.submitToolResult(answer);
    channel.emit({ type: "raw", rawValue: { type: "vgent-tool-result-expired", toolCallId: "q1" } }, ...gaveUp.slice(1));
    expect(await settled(control.done)).toBe("pending");
    expect(channel.starts()[1]!.prompt).toContain("- Which color?: Blue");

    channel.emit(...nextTurn);
    expect(await settled(control.done)).toBe("resolved");
    expect(texts(seen)).toEqual(["选项弹窗没弹出来", "Blue"]);
  });

  it("does not let an attach's replay of the ended turn end the continuation", async () => {
    const channel = new ScriptedChannel();
    // The bridge said `waiting` in its hello: the turn ended while no host was attached.
    const claude = session(channel, { attach: true, bridgeTurnOpen: false });
    channel.emit(...gaveUp);

    const seen: Array<Record<string, unknown>> = [];
    const control = await claude.doContinueTurn(turn(seen));
    await control.submitToolResult(answer);
    await macrotask();
    expect(channel.starts()).toHaveLength(1);
    expect(channel.starts()[0]).toMatchObject({ resumeSessionId: "claude-1" });
    expect(await settled(control.done)).toBe("pending");
    // Claude's own error result would overwrite the answer the user gave.
    expect(seen.filter((event) => event.type === "tool-result")).toEqual([]);

    channel.emit(...nextTurn);
    expect(await settled(control.done)).toBe("resolved");
  });

  it("sends nothing when the continuation is aborted before the answer goes out", async () => {
    const channel = new ScriptedChannel();
    const claude = session(channel);
    await claude.doPromptTurn(turn());
    channel.emit(question, ...gaveUp);

    const abort = new AbortController();
    const control = await claude.doContinueTurn(turn([], abort.signal));
    control.done.catch(() => {});
    await control.submitToolResult(answer);
    abort.abort();
    await macrotask();
    expect(channel.starts()).toHaveLength(1);
    expect(await settled(control.done)).toBe("rejected");
  });

  it("fails the answer on a closed channel instead of waiting", async () => {
    const channel = new ScriptedChannel();
    const claude = session(channel);
    const first = await claude.doPromptTurn(turn());
    first.done.catch(() => {});
    channel.emit(question);
    channel.close();

    const control = await claude.doContinueTurn(turn());
    control.done.catch(() => {});
    await expect(control.submitToolResult(answer)).rejects.toThrow("channel is closed");
    expect(await settled(control.done)).toBe("rejected");
  });
});
