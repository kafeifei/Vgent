/** Opt-in live evaluation. Never uses the user's project or session files as fixtures.
 * Run with the matching source-alias tsconfig for baseline/candidate comparison.
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVgentEngine, resolveModel } from "@vgent/engine";
import { wrapLanguageModel, type ModelMessage } from "ai";

const output = process.env.VGENT_EVAL_OUTPUT;
if (!output || process.env.VGENT_LIVE_EVAL !== "1") throw new Error("Set VGENT_LIVE_EVAL=1 and VGENT_EVAL_OUTPUT explicitly.");
const modelId = process.env.VGENT_EVAL_MODEL ?? "codex-subscription:gpt-5.5";
const version = process.env.VGENT_EVAL_VERSION ?? "candidate";
const repeat = Number(process.env.VGENT_EVAL_REPEATS ?? 3);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("At most three repeats.");
const root = await mkdtemp(join(tmpdir(), "vgent-eval-"));
await mkdir(output, { recursive: true, mode: 0o700 });
let totalCalls = 0;
const results: unknown[] = [];
const read = (path: string) => readFile(path, "utf8").catch(() => "");
const allNames = [
  "two-edits",
  "scoped-rule",
  "memory-quotation",
  "project-delivery",
  "regenerate",
  "long-context",
  "steer-correction",
  "verify-result",
  "remaining-plan",
  "large-output",
];
const names = process.env.VGENT_EVAL_ONLY ? allNames.filter((name) => process.env.VGENT_EVAL_ONLY!.split(",").includes(name)) : allNames;
for (let repetition = 0; repetition < repeat; repetition++)
  for (const name of names) {
    const dir = join(root, `${repetition}-${name}`);
    const main = join(root, `${repetition}-${name}-main`);
    await mkdir(dir, { recursive: true });
    await mkdir(main, { recursive: true });
    const memoryDir = join(dir, ".memory");
    const outputDir = join(dir, ".output");
    let prompt = "";
    let messages: ModelMessage[] | undefined;
    let steer: string | undefined;
    let check: () => Promise<boolean> = async () => false;
    if (name === "two-edits") {
      await writeFile(join(dir, "settings.txt"), "left=0\nright=0\n");
      prompt =
        "Read settings.txt, then change left=0 to left=1 and right=0 to right=1 using two edit calls in the same step. Verify the file.";
      check = async () => (await read(join(dir, "settings.txt"))) === "left=1\nright=1\n";
    } else if (name === "scoped-rule") {
      await mkdir(join(dir, "nested"));
      await writeFile(
        join(dir, "nested/AGENTS.md"),
        "When modifying nested/value.txt, its exact required format is VALUE=2;SCOPE=OK followed by a newline.",
      );
      await writeFile(join(dir, "nested/value.txt"), "VALUE=1\n");
      prompt = "Read nested/value.txt and change its value from 1 to 2. Follow applicable directory rules.";
      check = async () => (await read(join(dir, "nested/value.txt"))).trim() === "VALUE=2;SCOPE=OK";
    } else if (name === "memory-quotation") {
      prompt = "记住：写完发 debug，但别自动重启。用 memory 写到 delivery 条目，用户消息 ID 是 eval-user。";
      check = async () => {
        const value = await read(join(memoryDir, "delivery.md"));
        return value.includes("别自动重启") && !value.includes("不要替换") && !value.includes("禁止替换");
      };
    } else if (name === "project-delivery") {
      await writeFile(join(dir, "artifact.txt"), "BUILD_OK\n");
      prompt = `Authorized delivery: read artifact.txt and write the same bytes to ${join(main, "installed.txt")}. This second root is the configured main checkout for this synthetic task. Verify the installed file. No app processes exist here; do not ask again for authorization.`;
      check = async () => (await read(join(main, "installed.txt"))) === "BUILD_OK\n";
    } else if (name === "regenerate") {
      await writeFile(join(dir, "artifact.txt"), "generation=1\n");
      prompt =
        "Regenerate artifact.txt now as generation=2 followed by a newline. The existing generation=1 is from an earlier request and does not satisfy this one. Verify the new content.";
      check = async () => (await read(join(dir, "artifact.txt"))).trim() === "generation=2";
    } else if (name === "long-context") {
      messages = [{ role: "user", content: "Goal: write result.txt containing the exact token KEEP-731. Never create restart.txt." }];
      for (let i = 0; i < 10; i++)
        messages.push({
          role: i % 2 ? "assistant" : "user",
          content: `Historical unrelated observation ${i}: ${"old context ".repeat(220)}`,
        });
      for (let i = 0; i < 6; i++)
        messages.push({ role: i % 2 ? "assistant" : "user", content: `Recent observation ${i}: no changes yet.` });
      messages.push({ role: "user", content: "Continue the original goal now. Preserve its constraints." });
      check = async () => (await read(join(dir, "result.txt"))).trim() === "KEEP-731" && !(await read(join(dir, "restart.txt")));
    } else if (name === "steer-correction") {
      await writeFile(join(dir, "value.txt"), "COLOR=BLUE\n");
      prompt = "Read value.txt, then change BLUE to GREEN and verify.";
      steer = "Correction: use RED instead of GREEN. Continue and verify value.txt.";
      check = async () => (await read(join(dir, "value.txt"))).trim() === "COLOR=RED";
    } else if (name === "verify-result") {
      await writeFile(join(dir, "sum.cjs"), "module.exports=(a,b)=>a-b;\n");
      await writeFile(join(dir, "test.cjs"), "if(require('./sum.cjs')(2,3)!==5)process.exit(1); console.log('PASS');\n");
      prompt = "Fix sum.cjs so it adds two arguments. Run node test.cjs to verify. Preserve test.cjs.";
      check = async () => {
        const text = await read(join(dir, "sum.cjs"));
        return /a\s*\+\s*b/.test(text) && (await read(join(dir, "test.cjs"))).includes("!==5");
      };
    } else if (name === "remaining-plan") {
      await writeFile(join(dir, "done.txt"), "implementation done\n");
      prompt =
        "Status question: what remains? Answer briefly, then continue the unfinished task. The required delivery is to create delivered.txt containing DELIVERED. Verify before finishing.";
      check = async () => (await read(join(dir, "delivered.txt"))).trim() === "DELIVERED";
    } else {
      await writeFile(join(dir, "emit.cjs"), "process.stdout.write('x'.repeat(40000)+'\\nTAIL-913\\n');\n");
      prompt =
        "Run node emit.cjs. Verify its final token, then write the final token alone to tail.txt. Use output references if necessary.";
      check = async () => (await read(join(dir, "tail.txt"))).trim() === "TAIL-913";
    }
    const providerUsage = { inputTokens: 0, outputTokens: 0 };
    const account = (usage: any) => {
      providerUsage.inputTokens += usage?.inputTokens?.total ?? 0;
      providerUsage.outputTokens += usage?.outputTokens?.total ?? 0;
    };
    let calls = 0;
    let steered = false;
    let text = "";
    let error: string | undefined;
    const model = wrapLanguageModel({
      model: resolveModel(modelId) as any,
      middleware: {
        transformParams: async ({ params }) => {
          calls++;
          totalCalls++;
          if (calls > 12 || totalCalls > 240) throw new Error("Evaluation request budget reached");
          return { ...params, maxOutputTokens: 1200 };
        },
        wrapGenerate: async ({ doGenerate }) => {
          const result = await doGenerate();
          account(result.usage);
          return result;
        },
        wrapStream: async ({ doStream }) => {
          const result = await doStream();
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  if (part.type === "finish") account(part.usage);
                  controller.enqueue(part);
                },
              }),
            ),
          };
        },
      },
    });
    const engine = createVgentEngine({
      model,
      repoPath: dir,
      projectPath: main,
      outputDir,
      memoryDir,
      memorySources: [{ id: "eval-user", text: prompt }],
      permissionMode: "allow-all",
      subagents: false,
      maxSteps: 8,
      contextTokenBudget: name === "long-context" ? 7500 : 30000,
      ...(name === "remaining-plan"
        ? { taskState: { goal: "Deliver", items: [{ text: "create delivered.txt", status: "pending" as const }] } }
        : {}),
      pendingUserMessages: async () => (steer && !steered ? ((steered = true), [steer]) : []),
      instructions: `This is an isolated test fixture. Modify only ${dir} and ${main}. Do not use network, git, package installation, or process lifecycle commands. Finish within 8 steps.`,
    });
    const start = Date.now();
    let usage: unknown;
    try {
      const response = await engine.agent.stream({
        ...(messages ? { messages } : { prompt }),
        options: undefined,
        abortSignal: AbortSignal.timeout(90000),
      });
      text = await response.text;
      usage = await response.totalUsage;
      await writeFile(
        join(output, `${version}-${repetition}-${name}-messages.json`),
        JSON.stringify(await response.responseMessages, null, 2),
        { mode: 0o600 },
      );
    } catch (failure) {
      error = failure instanceof Error ? failure.message.slice(0, 300) : String(failure);
    }
    const pass = await check();
    const record = {
      name,
      repetition,
      version,
      modelId,
      pass,
      calls,
      elapsedMs: Date.now() - start,
      usage,
      providerUsage,
      error,
      outcome: (engine as any).outcome?.(),
      text,
      fixture: dir,
    };
    results.push(record);
    await writeFile(join(output, `${version}-results.json`), JSON.stringify({ modelId, version, totalCalls, results }, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify({ name, repetition, version, pass, calls, elapsedMs: record.elapsedMs, error }));
    await engine.dispose();
    if (totalCalls >= 240) throw new Error("Evaluation request budget reached");
  }
