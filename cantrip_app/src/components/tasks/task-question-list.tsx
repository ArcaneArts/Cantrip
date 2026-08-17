import type { TaskQuestion, TaskQuestionAnswer } from "@cantrip/protocol";
import { Check, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  setTaskQuestionAnswer,
  taskAnswerForQuestion,
} from "./task-review-state";

export function TaskQuestionList({
  answers,
  disabled,
  onChange,
  questions,
  showValidation,
}: {
  answers: readonly TaskQuestionAnswer[];
  disabled: boolean;
  onChange(answers: TaskQuestionAnswer[]): void;
  questions: readonly TaskQuestion[];
  showValidation: boolean;
}) {
  if (questions.length === 0) {
    return (
      <div className="border-y py-5 text-sm text-muted-foreground">
        The planner has no unresolved questions. You can add direction or run
        another refinement pass.
      </div>
    );
  }

  return (
    <div className="divide-y border-y">
      {questions.map((question, questionIndex) => {
        const answer = taskAnswerForQuestion(answers, question.id);
        const answered = Boolean(answer?.optionId || answer?.freeform?.trim());
        const descriptionId = `task-question-${question.id}-description`;
        const invalid = showValidation && question.required && !answered;
        return (
          <fieldset
            key={question.id}
            aria-describedby={descriptionId}
            aria-invalid={invalid}
            className="py-5 first:pt-4"
            disabled={disabled}
          >
            <legend className="w-full">
              <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>{String(questionIndex + 1).padStart(2, "0")}</span>
                <span>{question.header}</span>
                {question.required ? (
                  <span className="text-destructive">Required</span>
                ) : (
                  <span>Optional</span>
                )}
              </span>
              <span className="mt-1 block text-sm font-medium">
                {question.question}
              </span>
            </legend>
            <p id={descriptionId} className="sr-only">
              {question.required
                ? "An answer is required before continuing."
                : "This question is optional."}
            </p>

            {question.options.length > 0 ? (
              <div className="mt-3 divide-y border-y">
                {question.options.map((option) => {
                  const selected = answer?.optionId === option.id;
                  const recommended =
                    question.recommendedOptionId === option.id;
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 px-1 py-3 transition-colors",
                        selected && "bg-violet-500/5",
                        disabled && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <input
                        checked={selected}
                        className="mt-0.5 size-4 accent-violet-500"
                        name={`task-question-${question.id}`}
                        type="radio"
                        value={option.id}
                        onChange={() =>
                          onChange(
                            setTaskQuestionAnswer(
                              answers,
                              {
                                questionId: question.id,
                                optionId: option.id,
                                freeform: answer?.freeform ?? null,
                              },
                              question.id,
                            ),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {option.label}
                          {recommended ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-normal text-violet-500">
                              <Sparkles className="size-3" /> Recommended
                            </span>
                          ) : null}
                          {selected ? (
                            <Check className="size-3.5 text-violet-500" />
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            {question.allowFreeform ? (
              <label className="mt-3 block">
                <span className="text-xs text-muted-foreground">
                  {question.options.length > 0
                    ? "Freeform answer or additional context"
                    : "Your answer"}
                </span>
                <textarea
                  className="mt-1.5 min-h-24 w-full resize-y border bg-transparent px-3 py-2 text-sm outline-none transition-colors focus:border-violet-500 disabled:opacity-60"
                  maxLength={10_000}
                  placeholder="Type your answer…"
                  value={answer?.freeform ?? ""}
                  onChange={(event) => {
                    const freeform = event.target.value;
                    const next =
                      freeform.trim() || answer?.optionId
                        ? {
                            questionId: question.id,
                            optionId: answer?.optionId ?? null,
                            freeform: freeform || null,
                          }
                        : null;
                    onChange(setTaskQuestionAnswer(answers, next, question.id));
                  }}
                />
              </label>
            ) : null}

            {answered ? (
              <Button
                className="mt-2 h-7 px-2 text-[11px]"
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange(setTaskQuestionAnswer(answers, null, question.id))
                }
              >
                <X className="size-3" /> Clear answer
              </Button>
            ) : null}
            {invalid ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                Answer this question before continuing.
              </p>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}
