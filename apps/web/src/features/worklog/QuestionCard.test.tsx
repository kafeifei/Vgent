import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/features/style-lab/fixtures";
import type { AskUserQuestionsInput, QuestionAnswer } from "@/lib/types";
import { primaryAction, QuestionCard, submitArmed } from "./QuestionCard";

/** Claude Code's bridge: positional ids, partial answers always allowed. */
const card = (count: number, allowPartialAnswers = true): AskUserQuestionsInput => ({
  allowPartialAnswers,
  questions: Array.from({ length: count }, (_, index) => ({
    id: `question-${index + 1}`,
    question: `第 ${index + 1} 题？`,
    options: [
      { id: "option-1", label: "甲" },
      { id: "option-2", label: "乙" },
    ],
  })),
});
const pick = (...ids: string[]): Record<string, QuestionAnswer> =>
  Object.fromEntries(ids.map((id) => [id, { optionIds: ["option-1"] }]));

/** The attribute, not the `disabled:` classes every button carries. */
const DISABLED = 'disabled=""';

/** The foot's primary button in the first page's markup. */
const primaryButton = (input: AskUserQuestionsInput) => {
  const html = renderToStaticMarkup(createElement(QuestionCard, { id: "q", input, onSubmit: () => {} }));
  const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
  return buttons.at(-1)!;
};

describe("primaryAction", () => {
  it("turns the page after the first answer instead of sending the other three unanswered", () => {
    expect(primaryAction(card(4), pick("question-1"), 0)).toEqual({ kind: "next", disabled: false });
    expect(primaryAction(card(4), pick("question-1"), 2)).toEqual({ kind: "next", disabled: false });
  });

  it("lets a partial card move on past an unanswered question, a strict one only once it is answered", () => {
    expect(primaryAction(card(4), {}, 0)).toEqual({ kind: "next", disabled: false });
    expect(primaryAction(card(4, false), {}, 0)).toEqual({ kind: "next", disabled: true });
    expect(primaryAction(card(4, false), pick("question-1"), 0)).toEqual({ kind: "next", disabled: false });
  });

  it("submits on the last page by the same rule as before", () => {
    expect(primaryAction(card(4), pick("question-1"), 3)).toEqual({
      kind: "submit",
      disabled: false,
      output: { action: "partially-answered", answers: pick("question-1") },
    });
    expect(primaryAction(card(4), {}, 3)).toMatchObject({ kind: "submit", disabled: true });
    expect(primaryAction(card(4, false), pick("question-1", "question-4"), 3)).toMatchObject({ kind: "submit", disabled: true });
  });

  it("submits from any page once every question has an answer", () => {
    const all = pick("question-1", "question-2", "question-3", "question-4");
    expect(primaryAction(card(4), all, 0)).toEqual({ kind: "submit", disabled: false, output: { action: "answered", answers: all } });
    expect(primaryAction(card(4, false), all, 1)).toEqual({ kind: "submit", disabled: false, output: { action: "answered", answers: all } });
  });

  it("does not count a cleared choice or an empty line as an answer", () => {
    const cleared = { "question-1": { optionIds: [], freeform: "" } };
    expect(primaryAction(card(2, false), cleared, 0)).toEqual({ kind: "next", disabled: true });
  });

  it("counts a written answer on its own", () => {
    const written = { "question-1": { optionIds: [], freeform: "自己写" } };
    expect(primaryAction(card(2, false), written, 0)).toEqual({ kind: "next", disabled: false });
    expect(primaryAction(card(1, false), written, 0)).toEqual({ kind: "submit", disabled: false, output: { action: "answered", answers: written } });
  });

  it("is 继续 straight away on a one-question card", () => {
    expect(primaryAction(card(1), {}, 0)).toMatchObject({ kind: "submit", disabled: true });
    expect(primaryAction(card(1), pick("question-1"), 0)).toMatchObject({ kind: "submit", disabled: false, output: { action: "answered" } });
  });
});

describe("submitArmed", () => {
  it("ignores the tail of the page turn that put 继续 under the pointer", () => {
    expect(submitArmed(1_000, 1_080, 1)).toBe(false);
    expect(submitArmed(undefined, 1_080, 2)).toBe(false);
  });

  it("takes a deliberate click", () => {
    expect(submitArmed(undefined, 1_000, 1)).toBe(true);
    expect(submitArmed(1_000, 1_700, 1)).toBe(true);
    // Enter and Space report no click count.
    expect(submitArmed(1_000, 1_700, 0)).toBe(true);
  });
});

describe("QuestionCard", () => {
  it("opens a multi-question card on 下一题, enabled when partial answers are allowed", () => {
    const button = primaryButton(card(4));
    expect(button).toContain(">下一题<");
    expect(button).not.toContain(DISABLED);
    expect(primaryButton(card(4, false))).toContain(DISABLED);
  });

  it("opens a one-question card on 继续, disabled until something is chosen", () => {
    const button = primaryButton(card(1));
    expect(button).toContain(">继续<");
    expect(button).toContain(DISABLED);
  });

  it("renders the style-lab question on 下一题", () => {
    const part = SCENARIOS.find((scene) => scene.id === "question")!.messages.at(-1)!.parts.at(-1) as { input: AskUserQuestionsInput };
    expect(part.input.questions.length).toBeGreaterThan(1);
    expect(primaryButton(part.input)).toContain(">下一题<");
  });
});
