import type { TaskQuestion, TaskQuestionAnswer } from "@cantrip/protocol";

export function taskReviewInputSignature(
  answers: readonly TaskQuestionAnswer[],
  additionalDirection: string,
): string {
  return JSON.stringify([answers, additionalDirection]);
}

export function taskAnswerForQuestion(
  answers: readonly TaskQuestionAnswer[],
  questionId: string,
): TaskQuestionAnswer | undefined {
  return answers.find((answer) => answer.questionId === questionId);
}

export function setTaskQuestionAnswer(
  answers: readonly TaskQuestionAnswer[],
  answer: TaskQuestionAnswer | null,
  questionId: string,
): TaskQuestionAnswer[] {
  const next = answers.filter(
    (candidate) => candidate.questionId !== questionId,
  );
  if (answer) next.push(answer);
  return next;
}

export function unansweredRequiredTaskQuestions(
  questions: readonly TaskQuestion[],
  answers: readonly TaskQuestionAnswer[],
): TaskQuestion[] {
  const answered = new Set(
    answers
      .filter(
        (answer) =>
          Boolean(answer.optionId) || Boolean(answer.freeform?.trim()),
      )
      .map((answer) => answer.questionId),
  );
  return questions.filter(
    (question) => question.required && !answered.has(question.id),
  );
}
