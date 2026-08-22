import type {
  ChatPlanAnswer,
  ChatPlanState,
  PendingPlanQuestion,
} from "@cantrip/protocol";
import { CircleHelp, ListChecks, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export function buildPlanAnswers(
  question: PendingPlanQuestion,
  values: Record<string, string>,
  otherValues: Record<string, string>,
): ChatPlanAnswer["answers"] | null {
  const answers: ChatPlanAnswer["answers"] = {};
  for (const item of question.questions) {
    const selected = values[item.id]?.trim();
    const answer =
      selected === "__other__" ? otherValues[item.id]?.trim() : selected;
    if (!answer) return null;
    answers[item.id] = [answer];
  }
  return answers;
}

export function PlanPanel({
  error,
  onAnswer,
  pending,
  state,
}: {
  error?: string | null;
  onAnswer(answers: ChatPlanAnswer["answers"]): void;
  pending: boolean;
  state: ChatPlanState;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues({});
    setOtherValues({});
  }, [state.question?.id]);

  const answers = state.question
    ? buildPlanAnswers(state.question, values, otherValues)
    : null;
  if (state.mode !== "plan" && !state.question) return null;

  return (
    <section
      aria-label="Codex plan"
      data-slot="plan-panel"
      className="mb-2 flex max-h-[min(32rem,calc(100svh-12rem))] flex-col overflow-hidden rounded-xl border border-sky-500/35 bg-[var(--popover-solid)] text-popover-foreground shadow-2xl"
    >
      <div
        data-slot="plan-panel-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400">
            <ListChecks className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
              Plan Mode
            </div>
            {state.explanation ? (
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {state.explanation}
              </p>
            ) : null}
            {state.steps.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Codex is gathering context for a plan.
              </p>
            ) : null}
          </div>
        </div>

        {state.question ? (
          <div className="mt-3 border-t border-sky-500/20 pt-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CircleHelp className="size-4 text-amber-500" />
              Codex needs your input
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This question stays open until you answer it.
            </p>
            <div className="mt-3 space-y-4">
              {state.question.questions.map((question) => (
                <fieldset key={question.id} className="space-y-2">
                  <legend className="text-sm font-medium">
                    <span className="mr-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                      {question.header}
                    </span>
                    {question.question}
                  </legend>
                  {question.options ? (
                    <div className="space-y-1.5">
                      {question.options.map((option) => (
                        <label
                          key={option.label}
                          className="flex cursor-pointer items-start gap-2 rounded-md border bg-background/70 px-3 py-2 text-sm"
                        >
                          <input
                            type="radio"
                            name={question.id}
                            value={option.label}
                            checked={values[question.id] === option.label}
                            onChange={() =>
                              setValues((current) => ({
                                ...current,
                                [question.id]: option.label,
                              }))
                            }
                            className="mt-1"
                          />
                          <span>
                            <span className="block font-medium">
                              {option.label}
                            </span>
                            {option.description ? (
                              <span className="block text-xs leading-5 text-muted-foreground">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                      {question.isOther ? (
                        <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-background/70 px-3 py-2 text-sm">
                          <input
                            type="radio"
                            name={question.id}
                            value="__other__"
                            checked={values[question.id] === "__other__"}
                            onChange={() =>
                              setValues((current) => ({
                                ...current,
                                [question.id]: "__other__",
                              }))
                            }
                          />
                          <input
                            type={question.isSecret ? "password" : "text"}
                            aria-label={`Other answer for ${question.header}`}
                            value={otherValues[question.id] ?? ""}
                            onFocus={() =>
                              setValues((current) => ({
                                ...current,
                                [question.id]: "__other__",
                              }))
                            }
                            onChange={(event) =>
                              setOtherValues((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                              }))
                            }
                            placeholder="Other"
                            className="h-7 min-w-0 flex-1 bg-transparent outline-none"
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : (
                    <input
                      type={question.isSecret ? "password" : "text"}
                      value={values[question.id] ?? ""}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  )}
                </fieldset>
              ))}
            </div>
            {error ? (
              <p className="mt-3 text-sm text-destructive">{error}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {state.question ? (
        <div className="flex shrink-0 justify-end border-t border-sky-500/20 bg-[var(--popover-solid)] p-3">
          <Button
            type="button"
            size="sm"
            disabled={!answers || pending}
            onClick={() => answers && onAnswer(answers)}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Answer Codex
          </Button>
        </div>
      ) : null}
    </section>
  );
}
