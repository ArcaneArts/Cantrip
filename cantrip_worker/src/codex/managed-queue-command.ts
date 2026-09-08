import {
  managedQueueText,
  managedQueuePlanPrefix,
  stripManagedQueueTextPrefix,
} from "./managed-queue-text.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ManagedQueueNativeInput,
  NativeQueueUserInput,
} from "../managed-queue-input.js";

/** The pinned TUI strips only the recognized /plan prefix before native user input. */
export function managedQueueTurnInput(
  opened: ManagedQueueNativeInput,
): NativeQueueUserInput[] {
  if (opened.executionMethod !== "turn/start")
    throw new Error("The queued action is not model input.");
  if (opened.action !== "parseSlash") return structuredClone(opened.input);
  const plan = managedQueuePlanPrefix(opened.input);
  if (!plan?.hasInput)
    throw new Error("This queued slash command has no native model input.");
  return stripManagedQueueTextPrefix(opened.input, plan.length);
}

/** Matches pinned TUI goal materialization: retain rich references and spill long objectives to an immutable file. */
async function goalObjective(
  opened: ManagedQueueNativeInput,
  objective: string,
  codexHome: string,
  promptId: string,
): Promise<string> {
  const rich = opened.input.filter((item) => item.type !== "text");
  objective = objective.trim();
  if (!objective) throw new Error("Goal objective must not be empty.");
  if (!rich.length && Array.from(objective).length <= 4000) return objective;
  const bytes = createHash("sha256")
    .update(JSON.stringify([promptId, opened.input, objective]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const directory = path.join(codexHome, "attachments", uuid);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const references: string[] = [];
  for (const [index, item] of rich.entries()) {
    if (item.type === "image" || item.type === "audio") {
      const data = item.url.match(
        /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u,
      );
      if (data) {
        const extensions: Record<string, string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "image/gif": "gif",
          "audio/wav": "wav",
          "audio/mpeg": "mp3",
          "audio/ogg": "ogg",
          "audio/mp4": "m4a",
        };
        const file = path.join(
          directory,
          `${item.type}-${index + 1}.${extensions[data[1]!] ?? "bin"}`,
        );
        const content = Buffer.from(data[2]!, "base64");
        try {
          await writeFile(file, content, { mode: 0o600 });
        } finally {
          content.fill(0);
        }
        references.push(`- ${item.type}: ${file}`);
      } else references.push(`- ${item.type}: ${item.url}`);
    } else if (item.type === "skill" || item.type === "mention")
      references.push(`- ${item.type} ${item.name}: ${item.path}`);
    else if (item.type === "localImage" || item.type === "localAudio")
      references.push(`- ${item.type}: ${item.path}`);
  }
  const full = `${objective}${references.length ? `\n\nReferenced input:\n${references.join("\n")}` : ""}`;
  if (Array.from(full).length <= 4000) return full;
  const file = path.join(directory, "goal-objective.md");
  await writeFile(file, full, { encoding: "utf8", mode: 0o600 });
  return `Read the Codex goal objective file at ${file} before continuing.`;
}

export async function managedQueueNativeCommand(input: {
  opened: ManagedQueueNativeInput;
  threadId: string;
  promptId: string;
  codexHome: string;
}): Promise<{
  method:
    | "thread/goal/set"
    | "thread/goal/clear"
    | "thread/settings/update"
    | "thread/shellCommand";
  params: Record<string, unknown>;
  planMode?: "plan";
}> {
  const { opened, threadId } = input;
  const original = managedQueueText(opened.input);
  if (opened.action === "runShell") {
    if (opened.executionMethod !== "thread/shellCommand")
      throw new Error("The queued shell classification changed.");
    // Native TUI's leading ! is UI syntax; preserve the shell program, pipes and quoting verbatim.
    return {
      method: "thread/shellCommand",
      params: {
        threadId,
        command: original.startsWith("!") ? original.slice(1) : original,
      },
    };
  }
  if (opened.action === "parseSlash") {
    const plan = managedQueuePlanPrefix(opened.input);
    if (
      plan &&
      !plan.hasInput &&
      opened.executionMethod === "thread/settings/update"
    )
      return {
        method: "thread/settings/update",
        params: { threadId },
        planMode: "plan",
      };
    const goal = original.match(/^\/goal(?:\s+([\s\S]*))?$/u);
    if (!goal)
      throw new Error(
        "This queued slash command has no native command mapping.",
      );
    const argument = goal[1] ?? "";
    const control = argument.trim().toLowerCase();
    if (!control || control === "edit")
      throw new Error(
        "This goal command opens an interactive CLI view; the queued input was not dispatched.",
      );
    if (control === "clear") {
      if (opened.executionMethod !== "thread/goal/clear")
        throw new Error("The queued goal classification changed.");
      return { method: "thread/goal/clear", params: { threadId } };
    }
    if (opened.executionMethod !== "thread/goal/set")
      throw new Error("The queued goal classification changed.");
    if (control === "pause" || control === "resume")
      return {
        method: "thread/goal/set",
        params: { threadId, status: control === "pause" ? "paused" : "active" },
      };
    return {
      method: "thread/goal/set",
      params: {
        threadId,
        objective: await goalObjective(
          opened,
          argument,
          input.codexHome,
          input.promptId,
        ),
      },
    };
  }
  if (opened.executionMethod === "thread/goal/set")
    return {
      method: "thread/goal/set",
      params: {
        threadId,
        objective: await goalObjective(
          opened,
          original,
          input.codexHome,
          input.promptId,
        ),
      },
    };
  throw new Error("The queued action is model input, not a native command.");
}
