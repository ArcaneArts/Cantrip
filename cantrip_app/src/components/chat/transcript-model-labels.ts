import {
  nativeTurnSettingsForMessages,
  type NativeTurnSettingsEvidence,
} from "@/lib/native-turn-settings-evidence";
import type { AgentTranscriptEntry } from "./agent-turn-projection";
import { isWorkspaceSnapshot } from "./timeline";
import { turnSlices } from "./trajectory-model";

/** Attribute prompts from their own immutable native turn evidence. Composer
 * settings and configured routes cannot establish what a past turn used. */
export function transcriptModelLabels(
  entries: readonly AgentTranscriptEntry[],
  evidence: readonly NativeTurnSettingsEvidence[],
): Map<string, string> {
  const messages = entries
    .flatMap((entry) => {
      if (entry.type !== "timeline") return [];
      return entry.entry.type === "message"
        ? [entry.entry.message]
        : entry.entry.messages;
    })
    .flatMap((message) => {
      const content = message.content.filter((item) => {
        if (isWorkspaceSnapshot(item)) return false;
        const scope =
          item.type === "activity"
            ? item.activity.agentScope
            : item.type === "text"
              ? item.agentScope
              : null;
        return !scope || scope.isRoot;
      });
      return content.length ? [{ ...message, content }] : [];
    });
  const labels = new Map<string, string>();
  for (const slice of turnSlices(messages)) {
    const captures = nativeTurnSettingsForMessages(
      slice.messages,
      evidence,
    ).filter((capture) => capture.turnId === slice.runtimeTurnId);
    const capture = captures.length === 1 ? captures[0] : null;
    for (const message of slice.messages) {
      if (message.role !== "user") continue;
      if (capture?.status === "available") {
        labels.set(
          message.id,
          [message.providerName, capture.initialSettings.model]
            .filter(Boolean)
            .join(" · "),
        );
      } else {
        const route = [message.providerName, message.providerModelName]
          .filter(Boolean)
          .join(" · ");
        if (route) labels.set(message.id, `Configured route: ${route}`);
      }
    }
  }
  return labels;
}
