import type { NativeSuspensionError } from "@cantrip/protocol";
import { CodexNativeRpcError } from "./rpc-protocol.js";

type CheckpointCode = Extract<
  NativeSuspensionError["code"],
  "checkpoint-missing" | "checkpoint-corrupt" | "checkpoint-incompatible"
>;

const messages: Record<CheckpointCode, string> = {
  "checkpoint-missing":
    "Saved turn data is missing. Restore it and retry Resume, or Stop this turn.",
  "checkpoint-corrupt":
    "Saved turn data is damaged. Restore a valid copy, or Stop this turn.",
  "checkpoint-incompatible":
    "Saved turn data needs a compatible runtime. Retry with that runtime, or Stop this turn.",
};

/** A missing checkpoint observed by the actual native inspection operation. */
export class NativeSuspensionCheckpointMissing extends Error {
  constructor() {
    super(messages["checkpoint-missing"]);
  }
}

/** Categorize received native restoration failures without publishing their
 * diagnostics, which may contain private paths or continuation data. */
export function nativeSuspensionCheckpointError(error: unknown) {
  let code: CheckpointCode;
  if (error instanceof NativeSuspensionCheckpointMissing) {
    code = "checkpoint-missing";
  } else {
    if (
      !(error instanceof CodexNativeRpcError) ||
      !["turn/suspension", "thread/resume"].includes(error.requestMethod ?? "")
    )
      return null;
    const message = error.nativeError.message;
    if (
      /\bcheckpoint (?:runtime|format) version is unsupported\b/i.test(message)
    )
      code = "checkpoint-incompatible";
    else if (
      /\bcheckpoint (?:JSON|envelope|metadata|continuation) is corrupt\b|\bcheckpoint checksum does not match\b/i.test(
        message,
      )
    )
      code = "checkpoint-corrupt";
    else if (/\bnative suspension checkpoint is missing\b/i.test(message))
      code = "checkpoint-missing";
    else return null;
  }
  return { code, message: messages[code] };
}
