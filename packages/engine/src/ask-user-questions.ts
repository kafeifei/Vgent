import { tool } from "ai";
import { z } from "zod";

/**
 * Input schema for `askUserQuestions`. This is the shape of
 * `harnessV1QuestionsToolInputSchema` from `@ai-sdk/harness`, copied rather
 * than imported so the engine does not depend on the harness packages: the
 * in-house engine is the one path in Vgent that has nothing to do with
 * HarnessV1. Keep the two in sync — the UI renders both with one component.
 */
export const askUserQuestionsInputSchema = z.object({
  allowPartialAnswers: z.boolean().describe("Whether the user may answer only some of the questions."),
  questions: z
    .array(
      z.object({
        id: z.string().describe("Stable identifier for this question, used as the key of its answer."),
        question: z.string().describe("The question, phrased for the user."),
        header: z.string().optional().describe("Short label shown above the question."),
        options: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              description: z.string().optional(),
              preview: z.string().optional(),
            }),
          )
          .optional()
          .describe("Predefined choices. Omit for a free-form question."),
        allowMultiple: z.boolean().optional().describe("Whether more than one option may be selected."),
        allowFreeForm: z
          .union([z.boolean(), z.object({ secret: z.boolean() })])
          .optional()
          .describe("Whether the user may type an answer instead of picking an option."),
      }),
    )
    .min(1),
});

export type AskUserQuestionsInput = z.infer<typeof askUserQuestionsInputSchema>;

/** Output schema, matching `harnessV1QuestionsToolOutputSchema`. */
export const askUserQuestionsOutputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answered"),
    answers: z.record(z.string(), z.object({ optionIds: z.array(z.string()), freeform: z.string().optional() })),
  }),
  z.object({
    action: z.literal("partially-answered"),
    answers: z.record(z.string(), z.object({ optionIds: z.array(z.string()), freeform: z.string().optional() })),
  }),
  z.object({ action: z.literal("declined") }),
  z.object({ action: z.literal("cancelled") }),
]);

export type AskUserQuestionsOutput = z.infer<typeof askUserQuestionsOutputSchema>;

/**
 * Asks the user structured questions.
 *
 * Deliberately has **no** `execute`: a tool without one ends the agent loop, so
 * the call surfaces to whatever is driving the agent (the TUI, the web UI) and
 * the answer comes back as the tool's output on the next call. That is the AI
 * SDK's own mechanism for human input, and it is why this is not modelled as an
 * approval.
 */
export const askUserQuestionsTool = tool({
  description:
    "Ask the user one or more questions and wait for their answers. Use only for decisions that are the " +
    "user's to make; do not use it to ask permission to run a tool.",
  inputSchema: askUserQuestionsInputSchema,
  outputSchema: askUserQuestionsOutputSchema,
});
