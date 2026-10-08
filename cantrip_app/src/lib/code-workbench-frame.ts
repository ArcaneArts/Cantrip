import {
  CODE_WORKBENCH_FRAME_NONCE_PARAMETER,
  codeWorkbenchFrameFailureMessageSchema,
  codeWorkbenchFrameNonceSchema,
} from "@cantrip/protocol/code-workbench-frame";

export { CODE_WORKBENCH_FRAME_NONCE_PARAMETER };
export const CODE_WORKBENCH_READY_MESSAGE_TYPE = "cantrip-code.workbench-ready";
export const CODE_WORKBENCH_READY_MESSAGE_VERSION = 1;
export const CODE_WORKBENCH_READY_TIMEOUT_MS = 15_000;

export interface CodeWorkbenchFrameMount {
  nonce: string;
  origin: string;
  url: string;
}

export class CodeWorkbenchFrameLoadTracker {
  #lastLoadedNonce: string | null = null;

  observe(nonce: string): boolean {
    const repeated = this.#lastLoadedNonce === nonce;
    this.#lastLoadedNonce = nonce;
    return repeated;
  }
}

export type CodeWorkbenchStage =
  "endpoint" | "file" | "frame" | "presentation" | "workbench";

export class CodeWorkbenchStageError extends Error {
  readonly stage: CodeWorkbenchStage;

  constructor(stage: CodeWorkbenchStage, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodeWorkbenchStageError";
    this.stage = stage;
  }
}

export function createCodeWorkbenchFrameMount(
  attachmentUrl: string,
  nonce = crypto.randomUUID().replaceAll("-", ""),
): CodeWorkbenchFrameMount {
  if (!codeWorkbenchFrameNonceSchema.safeParse(nonce).success) {
    throw new Error("Cantrip Code frame nonce is invalid.");
  }
  const url = new URL(attachmentUrl);
  url.searchParams.set(CODE_WORKBENCH_FRAME_NONCE_PARAMETER, nonce);
  return { nonce, origin: url.origin, url: url.toString() };
}

export function isCodeWorkbenchReadyMessage(
  value: unknown,
  nonce: string,
): boolean {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === CODE_WORKBENCH_READY_MESSAGE_TYPE &&
    message.version === CODE_WORKBENCH_READY_MESSAGE_VERSION &&
    message.nonce === nonce
  );
}

export function isCodeWorkbenchReadyEvent(
  event: Pick<MessageEvent<unknown>, "data" | "origin" | "source">,
  frameWindow: Window | null,
  mount: CodeWorkbenchFrameMount,
): boolean {
  return (
    frameWindow !== null &&
    event.source === frameWindow &&
    event.origin === mount.origin &&
    isCodeWorkbenchReadyMessage(event.data, mount.nonce)
  );
}

export function codeWorkbenchStageError(
  stage: CodeWorkbenchStage,
  reason?: unknown,
): CodeWorkbenchStageError {
  const detail =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : null;
  const prefix =
    stage === "endpoint"
      ? "Cantrip Code endpoint failed"
      : stage === "frame"
        ? "Cantrip Code frame failed"
        : stage === "workbench"
          ? "Cantrip Code workbench did not become ready"
          : stage === "presentation"
            ? "Cantrip Code editor presentation failed"
            : "Cantrip Code file open failed";
  return new CodeWorkbenchStageError(
    stage,
    detail ? `${prefix}: ${detail}` : `${prefix}.`,
    reason,
  );
}

export function codeWorkbenchFrameFailure(
  event: Pick<MessageEvent<unknown>, "data" | "origin" | "source">,
  frameWindow: Window | null,
  mount: CodeWorkbenchFrameMount,
): CodeWorkbenchStageError | null {
  if (
    frameWindow === null ||
    event.source !== frameWindow ||
    event.origin !== mount.origin
  ) {
    return null;
  }
  const parsed = codeWorkbenchFrameFailureMessageSchema.safeParse(event.data);
  if (!parsed.success || parsed.data.nonce !== mount.nonce) return null;
  return codeWorkbenchStageError(
    "frame",
    `The embedded editor endpoint returned HTTP ${parsed.data.statusCode}.`,
  );
}
