import { z } from "zod";
import { tool } from "ai";
import { createBashTool, bashOutputSchema, type BashToolDeps } from "./tools/bash.js";

/** Coalesce progress while the consumer is busy; never buffer an unbounded event queue. */
export function createStreamingBashTool(deps: BashToolDeps) {
  const base = createBashTool(deps);
  return tool({
    description: base.description!,
    inputSchema: base.inputSchema,
    outputSchema: z.union([bashOutputSchema, z.object({ status: z.literal("running"), stdout: z.string(), stderr: z.string() })]),
    execute: async function* (input, options) {
      let progress: { stdout: string; stderr: string } | undefined;
      let wake: (() => void) | undefined;
      let done = false;
      let failure: unknown;
      let output: Awaited<ReturnType<NonNullable<typeof base.execute>>> | undefined;
      const runner: BashToolDeps["runner"] = {
        run: (request) =>
          deps.runner.run({
            ...request,
            onOutput: (next) => {
              progress = next;
              wake?.();
            },
          }),
      };
      const operation = Promise.resolve(createBashTool({ ...deps, runner }).execute!(input, options))
        .then(
          (value) => {
            output = value;
          },
          (error: unknown) => {
            failure = error;
          },
        )
        .finally(() => {
          done = true;
          wake?.();
        });
      while (!done) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (done || progress) resolve();
        });
        if (progress && !done) {
          const next = progress;
          progress = undefined;
          yield { status: "running" as const, ...next };
        }
      }
      await operation;
      if (failure != null) throw failure;
      if (output != null) yield output;
    },
  });
}
