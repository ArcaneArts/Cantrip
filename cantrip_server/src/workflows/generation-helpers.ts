import type { ChatMessage } from "@cantrip/protocol";

import { errorMessage } from "../http/request-helpers.js";

export function workflowGenerationTranscript(messages: ChatMessage[]): string {
  const transcript = messages
    .slice(-80)
    .map((message) => {
      const text = message.content
        .flatMap((item) => {
          if (item.type === "text") return [item.text];
          if (item.type === "attachment") {
            return ["[attachment]"];
          }
          return [];
        })
        .join("\n");
      return text ? `${message.role.toUpperCase()}: ${text}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  return transcript.length <= 40_000
    ? transcript
    : transcript.slice(transcript.length - 40_000);
}

export function parseGeneratedJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Codex returned invalid ${label} JSON: ${errorMessage(error)}`,
    );
  }
}
