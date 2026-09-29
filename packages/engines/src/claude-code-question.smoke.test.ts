import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { createClaudeCodeEngine, type ClaudeCodeEngine } from "./claude-code.js";

/**
 * Claude Code's AskUserQuestion, answered in time and answered after the
 * question expired, against the real runtime and the caller's own login.
 *
 * The question rides a PreToolUse hook whose timeout the patched bridge reads
 * from `HARNESS_QUESTION_TIMEOUT_SECONDS`; five seconds here stands in for the
 * default day. An expired question used to leave the continuation waiting
 * forever: the answer went into a bridge turn that had already ended. Off by
 * default like the other smoke tests.
 */
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;

const QUESTION_TIMEOUT_SECONDS = 5;
/** How long the answered continuation may take before the test calls it hung. */
const CONTINUATION_TIMEOUT_MS = 180_000;

const PROMPT = [
  'Use your AskUserQuestion tool to ask me exactly one question, "Which color?", with exactly two options, Red and Blue, single choice.',
  "Do not use any other tool.",
  "After I answer, reply with only the color I chose.",
  'If the question fails or times out, do not ask again: reply with only the words "no answer".',
].join(" ");

interface AskedQuestion {
  toolCallId: string;
  input: {
    questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }> }>;
  };
}

type Part = TextStreamPart<ToolSet>;

async function readParts(stream: ReadableStream<Part>): Promise<Part[]> {
  const parts: Part[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function textOf(parts: readonly Part[]): string {
  return parts.map((part) => (part.type === "text-delta" ? part.text : "")).join("");
}

async function newEngine(label: string): Promise<{ engine: ClaudeCodeEngine; dataDir: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), `vgent-smoke-question-${label}-`));
  execFileSync("git", ["init", "--quiet"], { cwd: repoPath });
  const dataDir = process.env.VGENT_SMOKE_DATA_DIR ?? join(tmpdir(), "vgent-smoke-data");
  const engine = await createClaudeCodeEngine({
    repoPath,
    permissionMode: "allow-reads",
    dataDir,
    env: { HARNESS_QUESTION_TIMEOUT_SECONDS: String(QUESTION_TIMEOUT_SECONDS) },
  });
  return { engine, dataDir };
}

/** Runs the prompt up to the pause at the question and returns the question. */
async function ask(engine: ClaudeCodeEngine): Promise<AskedQuestion> {
  const result = await engine.harnessAgent.stream({ session: engine.session, prompt: PROMPT, options: undefined });
  const parts = await readParts(result.stream as ReadableStream<Part>);
  console.log(`[smoke] first stream: ${parts.map((part) => part.type).join(", ")}`);
  const call = parts.find((part) => part.type === "tool-call" && part.toolName === "askUserQuestions");
  if (call == null || call.type !== "tool-call") throw new Error(`Claude did not ask a question. Text: ${textOf(parts)}`);
  const asked = { toolCallId: call.toolCallId, input: call.input as AskedQuestion["input"] };
  console.log(`[smoke] question: ${JSON.stringify(asked.input)}`);
  return asked;
}

/**
 * Answers Blue the way Vgent's run manager does inside one process: the parked
 * runner calls `stream()` on the same session again with the converted
 * history, whose trailing `role: 'tool'` message carries the answer.
 */
async function answerBlue(engine: ClaudeCodeEngine, asked: AskedQuestion): Promise<string> {
  const question = asked.input.questions[0];
  const blue = question?.options.find((option) => /blue/i.test(option.label));
  if (question == null || blue == null) throw new Error(`No Blue option in ${JSON.stringify(asked.input)}`);
  const output = { action: "answered", answers: { [question.id]: { optionIds: [blue.id] } } };
  const messages: ModelMessage[] = [
    { role: "user", content: PROMPT },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: asked.toolCallId, toolName: "askUserQuestions", input: asked.input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: asked.toolCallId, toolName: "askUserQuestions", output: { type: "json", value: output } }] },
  ];

  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`The answered continuation did not finish within ${CONTINUATION_TIMEOUT_MS / 1000}s.`));
    }, CONTINUATION_TIMEOUT_MS);
  });
  try {
    const parts = await Promise.race([
      (async () => {
        const result = await engine.harnessAgent.stream({ session: engine.session, messages, abortSignal: abort.signal, options: undefined });
        return readParts(result.stream as ReadableStream<Part>);
      })(),
      hung,
    ]);
    console.log(`[smoke] continuation stream: ${parts.map((part) => part.type).join(", ")}`);
    const error = parts.find((part) => part.type === "error");
    if (error != null && error.type === "error") throw new Error(`The continuation failed: ${String(error.error)}`);
    return textOf(parts);
  } finally {
    clearTimeout(timer);
  }
}

async function readBridgeFile<T>(dataDir: string, sessionId: string, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(join(dataDir, ".agent-runs", sessionId, "bridge", name), "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The bridge's own record of whether it is running a turn (`running`) or idle (`waiting`). */
async function bridgeState(dataDir: string, sessionId: string): Promise<string | undefined> {
  return (await readBridgeFile<{ state?: string }>(dataDir, sessionId, "bridge-meta.json"))?.state;
}

/** What the bridge's current (or last) turn emitted: event types and text. */
async function bridgeTurnSummary(dataDir: string, sessionId: string): Promise<string> {
  try {
    const log = await readFile(join(dataDir, ".agent-runs", sessionId, "bridge", "event-log.ndjson"), "utf8");
    const events = log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; delta?: string });
    const text = events.map((event) => (event.type === "text-delta" ? (event.delta ?? "") : "")).join("");
    return `${events.map((event) => event.type).join(", ")} | text ${JSON.stringify(text)}`;
  } catch {
    return "(no event log)";
  }
}

/** The prompt of the last `start` the bridge received. */
async function lastStartPrompt(dataDir: string, sessionId: string): Promise<string | undefined> {
  return (await readBridgeFile<{ prompt?: string }>(dataDir, sessionId, "start-config.json"))?.prompt;
}

describe("Claude Code AskUserQuestion (smoke)", () => {
  smoke(
    "delivers an answer given while the question is open",
    async () => {
      const { engine, dataDir } = await newEngine("open");
      try {
        const asked = await ask(engine);
        const text = await answerBlue(engine, asked);
        console.log(`[smoke] reply to the open question: ${JSON.stringify(text)}`);
        expect(text).toMatch(/blue/i);
        // Answered through the waiting hook: no second `start` was needed.
        expect(await lastStartPrompt(dataDir, engine.session.sessionId)).toBe(PROMPT);
      } finally {
        await engine.dispose();
      }
    },
    15 * 60_000,
  );

  smoke(
    "delivers an answer given after the question expired instead of hanging",
    async () => {
      const { engine, dataDir } = await newEngine("expired");
      try {
        const asked = await ask(engine);
        // Past the hook timeout, and until the bridge turn has actually ended:
        // that is the state the answer used to vanish into.
        await sleep(10_000);
        const deadline = Date.now() + 120_000;
        let state = await bridgeState(dataDir, engine.session.sessionId);
        while (state !== "waiting" && Date.now() < deadline) {
          await sleep(1_000);
          state = await bridgeState(dataDir, engine.session.sessionId);
        }
        console.log(`[smoke] bridge state before the late answer: ${state}`);
        console.log(`[smoke] the question's turn in the bridge: ${await bridgeTurnSummary(dataDir, engine.session.sessionId)}`);
        expect(state).toBe("waiting");

        const text = await answerBlue(engine, asked);
        console.log(`[smoke] reply to the expired question: ${JSON.stringify(text)}`);
        expect(text).toMatch(/blue/i);
        // The answer reached Claude as a new turn in the same conversation.
        const prompt = await lastStartPrompt(dataDir, engine.session.sessionId);
        console.log(`[smoke] late-answer prompt: ${JSON.stringify(prompt)}`);
        expect(prompt).toMatch(/AskUserQuestion call after that call had timed out:\n- .+: Blue$/);
      } finally {
        await engine.dispose();
      }
    },
    15 * 60_000,
  );
});
