import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { AskUserQuestionsInput, AskUserQuestionsOutput, QuestionAnswer } from "@/lib/types";

type Answers = Record<string, QuestionAnswer>;

/** The foot's primary button: 下一题 turns the page, 继续 submits the card. */
export type PrimaryAction = { kind: "next"; disabled: boolean } | { kind: "submit"; disabled: boolean; output: AskUserQuestionsOutput };

const isAnswered = (answer: QuestionAnswer | undefined) =>
  answer != null && (answer.optionIds.length > 0 || (answer.freeform ?? "") !== "");

/**
 * 下一题 on every page but the last, so answering one question never sends the rest
 * unanswered; 继续 on the last page, or on any page once every question has an answer.
 */
export function primaryAction(input: AskUserQuestionsInput, answers: Answers, page: number): PrimaryAction {
  const { questions, allowPartialAnswers } = input;
  const allAnswered = questions.every((q) => isAnswered(answers[q.id]));
  if (page < questions.length - 1 && !allAnswered) {
    const current = questions[page];
    return { kind: "next", disabled: !allowPartialAnswers && !isAnswered(current == null ? undefined : answers[current.id]) };
  }
  return {
    kind: "submit",
    disabled: allowPartialAnswers ? !questions.some((q) => isAnswered(answers[q.id])) : !allAnswered,
    output: { action: allowPartialAnswers && !allAnswered ? "partially-answered" : "answered", answers },
  };
}

/**
 * How long after a page turn 继续 ignores clicks: the page turn puts 继续 under
 * the pointer (and the focus) that just pressed 下一题, so the second click of a
 * double-click or a repeated Enter would otherwise send the card unfinished.
 */
const SUBMIT_GUARD_MS = 600;

/** Whether a click on 继续 is a fresh decision rather than the tail of the page turn. */
export function submitArmed(turnedAt: number | undefined, now: number, clickCount: number): boolean {
  return clickCount <= 1 && (turnedAt == null || now - turnedAt >= SUBMIT_GUARD_MS);
}

/**
 * `askUserQuestions`, Cursor-style: one question per page, numbered options,
 * `‹ ›` paging, 跳过 / 下一题 / 继续 at the foot.
 */
export function QuestionCard({
  id,
  input,
  onSubmit,
}: {
  id: string;
  input: AskUserQuestionsInput;
  onSubmit: (output: AskUserQuestionsOutput) => void;
}) {
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const turnedAt = useRef<number | undefined>(undefined);

  const questions = input.questions;
  const question = questions[page];
  if (question == null) return null;

  const selected = answers[question.id]?.optionIds ?? [];
  const freeform = answers[question.id]?.freeform ?? "";

  // A cleared text box is no answer: an empty `freeform` would otherwise stand
  // in for the option picked after it (Claude Code prefers the text).
  const update = (patch: Partial<QuestionAnswer>) =>
    setAnswers((previous) => {
      const { freeform: text, ...rest } = { ...(previous[question.id] ?? { optionIds: [] }), ...patch };
      return { ...previous, [question.id]: text ? { ...rest, freeform: text } : rest };
    });
  const turnPage = (next: number) => {
    turnedAt.current = performance.now();
    setPage(next);
  };

  const primary = primaryAction(input, answers, page);

  return (
    <article id={id} className="rounded-lg border border-border bg-bg-elevated px-md py-sm">
      <div className="mb-xs flex items-center gap-xs">
        <span className="text-2xs text-fg-faint tracking-widest">
          问题 {page + 1} / {questions.length}
        </span>
        <span className="ml-auto flex gap-3xs">
          <button
            type="button"
            aria-label="上一个"
            disabled={page === 0}
            onClick={() => turnPage(Math.max(0, page - 1))}
            className="grid size-lg place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="下一个"
            disabled={page >= questions.length - 1}
            onClick={() => turnPage(Math.min(questions.length - 1, page + 1))}
            className="grid size-lg place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            ›
          </button>
        </span>
      </div>

      {question.header != null && <div className="mb-3xs text-2xs text-fg-faint tracking-widest">{question.header}</div>}
      <div className="mb-xs text-body">{question.question}</div>

      {(question.options ?? []).map((option, index) => {
        const checked = selected.includes(option.id);
        return (
          <label
            key={option.id}
            className={cn(
              "flex cursor-pointer items-start gap-xs rounded-sm px-xs py-2xs text-sm hover:bg-bg-hover",
              checked && "bg-bg-active",
            )}
          >
            <input
              type={question.allowMultiple === true ? "checkbox" : "radio"}
              name={`${id}-${question.id}`}
              checked={checked}
              onChange={(event) =>
                update({
                  optionIds:
                    question.allowMultiple === true
                      ? event.target.checked
                        ? [...selected, option.id]
                        : selected.filter((value) => value !== option.id)
                      : [option.id],
                })
              }
              className="sr-only"
            />
            <span
              className={cn(
                "grid size-lg flex-none place-items-center rounded-sm font-mono text-xs",
                checked ? "bg-brand font-bold text-brand-fg" : "bg-bg-inset text-fg-faint",
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              {option.label}
              {option.description != null && <span className="block text-fg-muted text-xs">{option.description}</span>}
            </span>
          </label>
        );
      })}

      {question.allowFreeForm === true && (
        <input
          value={freeform}
          onChange={(event) => update({ freeform: event.target.value })}
          placeholder="或者自己写一句…"
          className="mt-xs w-full rounded-sm border border-border bg-bg-inset px-sm py-xs text-sm outline-none placeholder:text-fg-faint focus-visible:border-border-strong"
        />
      )}

      <div className="mt-sm flex gap-xs">
        <button
          type="button"
          onClick={() => onSubmit({ action: "declined" })}
          className="inline-flex h-xl items-center rounded-md border border-border bg-bg-elevated px-sm text-fg text-xs hover:border-border-strong hover:bg-bg-active"
        >
          跳过
        </button>
        <button
          type="button"
          disabled={primary.disabled}
          onClick={(event) => {
            if (primary.kind === "next") turnPage(page + 1);
            else if (submitArmed(turnedAt.current, performance.now(), event.detail)) onSubmit(primary.output);
          }}
          className="inline-flex h-xl items-center rounded-md border border-brand bg-brand px-sm font-semibold text-brand-fg text-xs hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {primary.kind === "next" ? "下一题" : "继续"}
        </button>
      </div>
    </article>
  );
}
