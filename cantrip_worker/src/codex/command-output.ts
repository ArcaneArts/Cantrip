import { stripVTControlCharacters } from "node:util";
import { agentCommandOutputLimitBytes } from "@cantrip/protocol";
import type {
  CommandOutputBuffer,
  CommandTelemetryValue,
} from "./runtime-types.js";

export function appendBoundedCommandOutput(
  current: CommandOutputBuffer,
  delta: string,
): CommandOutputBuffer {
  if (!delta) return current;
  const plainDelta = stripVTControlCharacters(delta);
  let safeDelta = "";
  for (const character of plainDelta) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a &&
        codePoint !== 0x0d) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      continue;
    }
    safeDelta += character;
  }
  if (!safeDelta) return current;
  const currentBytes = Buffer.from(current.output ?? "", "utf8");
  const deltaBytes = Buffer.from(safeDelta, "utf8");
  const totalBytes = currentBytes.byteLength + deltaBytes.byteLength;
  if (totalBytes <= agentCommandOutputLimitBytes) {
    return {
      output: `${current.output ?? ""}${safeDelta}`,
      truncated: current.truncated,
    };
  }

  const retained = Buffer.allocUnsafe(agentCommandOutputLimitBytes);
  const deltaStart = Math.max(0, deltaBytes.byteLength - retained.byteLength);
  const retainedDelta = deltaBytes.subarray(deltaStart);
  const retainedCurrentBytes = retained.byteLength - retainedDelta.byteLength;
  if (retainedCurrentBytes > 0) {
    currentBytes.copy(
      retained,
      0,
      Math.max(0, currentBytes.byteLength - retainedCurrentBytes),
    );
  }
  retainedDelta.copy(retained, Math.max(0, retainedCurrentBytes));

  let start = 0;
  while (start < retained.byteLength && (retained[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return {
    output: retained.subarray(start).toString("utf8"),
    truncated: true,
  };
}

export function boundedCommandOutput(
  output: string | null,
): CommandOutputBuffer {
  return appendBoundedCommandOutput(
    { output: null, truncated: false },
    output ?? "",
  );
}

export function transcriptCommandOutput(output: string | null): string | null {
  if (!output || output.length <= 20_000) return output;
  return `…output truncated…\n${output.slice(-20_000)}`;
}

export function commandTelemetryFromDelta(
  current: CommandTelemetryValue | null,
  delta: string,
  observedAtMs: number,
): CommandTelemetryValue {
  return {
    ...appendBoundedCommandOutput(
      current ?? { output: null, truncated: false },
      delta,
    ),
    startedAtMs: current?.startedAtMs ?? observedAtMs,
    updatedAtMs: observedAtMs,
  };
}

export function commandTelemetryFromStart(
  current: CommandTelemetryValue | null,
  aggregatedOutput: string | null,
  startedAtMs: number,
  observedAtMs: number,
): CommandTelemetryValue {
  const initial = boundedCommandOutput(aggregatedOutput);
  return {
    output: current?.output ?? initial.output,
    truncated: current?.truncated ?? initial.truncated,
    startedAtMs,
    updatedAtMs: observedAtMs,
  };
}

export function commandTelemetryFromCompletion(
  current: CommandTelemetryValue | null,
  aggregatedOutput: string | null,
  durationMs: number | null | undefined,
  observedAtMs: number,
): CommandTelemetryValue {
  const output =
    aggregatedOutput === null
      ? {
          output: current?.output ?? null,
          truncated: current?.truncated ?? false,
        }
      : boundedCommandOutput(aggregatedOutput);
  return {
    ...output,
    startedAtMs:
      current?.startedAtMs ??
      (durationMs === null || durationMs === undefined
        ? observedAtMs
        : Math.max(0, observedAtMs - durationMs)),
    updatedAtMs: observedAtMs,
  };
}
