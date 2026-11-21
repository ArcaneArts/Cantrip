import type { DecisionQuestion } from "@cantrip/protocol";
import {
  decisionImageAsset,
  inlineDecisionMedia,
} from "./model-decision-media.js";
import { ModelOperationError } from "./model-operation-error.js";

export function openAiDecisionQuestions(questions: DecisionQuestion[]) {
  return questions.map((question) => {
    const text =
      question.type === "predicate" && question.criteria
        ? [
            question.instructions,
            `True: ${question.criteria.true}`,
            `False: ${question.criteria.false}`,
          ]
            .filter((value) => value !== undefined)
            .join("\n")
        : question.instructions;
    const images = question.instructionImages ?? [];
    return {
      type: question.type,
      name: question.id,
      ...(text !== undefined || images.length
        ? {
            instructions: images.length
              ? [
                  ...(text !== undefined ? [{ type: "input_text", text }] : []),
                  ...images.map((image) => ({
                    type: "input_image",
                    image_url: image.url,
                  })),
                ]
              : text,
          }
        : {}),
      ...(question.type === "choice"
        ? {
            choices: question.choices.map((choice) => ({
              value: choice.id,
              ...(typeof choice.description === "string"
                ? { description: choice.description }
                : {}),
            })),
          }
        : {}),
      ...(question.type === "score"
        ? {
            levels: question.levels.map((level) => ({
              label: level.id,
              ...(typeof level.description === "string"
                ? { description: level.description }
                : {}),
            })),
          }
        : {}),
    };
  });
}

export function systemOneDecisionQuestions(
  questions: DecisionQuestion[],
  adapter: "system-one" | "openrouter-decisions",
  typesafeImages = false,
) {
  const assets: Record<string, unknown> = {};
  const result = Object.fromEntries(
    questions.map((question) => {
      const images = question.instructionImages ?? [];
      if (
        images.length &&
        adapter !== "openrouter-decisions" &&
        !typesafeImages
      )
        throw new ModelOperationError(
          "unsupported-input",
          "This System One envelope has no question-specific image placement. Use shared media or an adapter that supports instruction images.",
        );
      const references: string[] = [];
      const parts = images.map((image) => {
        if (adapter === "system-one") {
          const { reference, asset } = decisionImageAsset(image.url);
          assets[reference] = asset;
          references.push(reference);
          return reference;
        }
        inlineDecisionMedia(image.url, "image");
        return { type: "image_url", image_url: { url: image.url } };
      });
      return [
        question.id,
        {
          type: question.type === "predicate" ? "noul" : question.type,
          ...(question.instructions !== undefined || parts.length
            ? {
                instructions: references.length
                  ? [question.instructions, ...references]
                      .filter((value) => value !== undefined)
                      .join("\n")
                  : parts.length
                    ? [
                        ...(question.instructions !== undefined
                          ? [question.instructions]
                          : []),
                        ...parts,
                      ]
                    : question.instructions,
              }
            : {}),
          ...(question.type === "predicate" && question.criteria
            ? { criteria: question.criteria }
            : {}),
          ...(question.type === "choice"
            ? {
                criteria: Object.fromEntries(
                  question.choices.map((choice) => [
                    choice.id,
                    choice.description ?? null,
                  ]),
                ),
              }
            : {}),
          ...(question.type === "score"
            ? {
                criteria: question.levels.map(
                  (level) => level.description ?? level.id,
                ),
              }
            : {}),
        },
      ];
    }),
  );
  return { questions: result, assets };
}
