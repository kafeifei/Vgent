import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AskUserQuestionsInput, AskUserQuestionsOutput, QuestionAnswer } from "@/lib/types";

/**
 * `askUserQuestions`, Cursor-style: one question per page, numbered options,
 * `‹ ›` paging, 跳过 / 继续 at the foot.
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
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});

  const questions = input.questions;
  const question = questions[page];
  if (question == null) return null;

  const selected = answers[question.id]?.optionIds ?? [];
  const freeform = answers[question.id]?.freeform ?? "";

  const update = (patch: Partial<QuestionAnswer>) =>
    setAnswers((previous) => {
      const current = previous[question.id] ?? { optionIds: [] };
      return { ...previous, [question.id]: { ...current, ...patch } };
    });

  const answered = (id: string) => {
    const answer = answers[id];
    return answer != null && (answer.optionIds.length > 0 || (answer.freeform ?? "") !== "");
  };
  const canSubmit = input.allowPartialAnswers ? questions.some((q) => answered(q.id)) : questions.every((q) => answered(q.id));

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
            onClick={() => setPage((value) => Math.max(0, value - 1))}
            className="grid size-lg place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="下一个"
            disabled={page >= questions.length - 1}
            onClick={() => setPage((value) => Math.min(questions.length - 1, value + 1))}
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
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              action: input.allowPartialAnswers && !questions.every((q) => answered(q.id)) ? "partially-answered" : "answered",
              answers,
            })
          }
          className="inline-flex h-xl items-center rounded-md border border-brand bg-brand px-sm font-semibold text-brand-fg text-xs hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          继续
        </button>
      </div>
    </article>
  );
}
