import { stripVTControlCharacters } from "node:util";
import type { RpcMessage } from "./runtime-types.js";

export function parseCodexRpcMessage(raw: string): RpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (
    message.id !== undefined &&
    typeof message.id !== "number" &&
    typeof message.id !== "string"
  ) {
    return null;
  }
  if (message.method !== undefined && typeof message.method !== "string") {
    return null;
  }
  if (message.id === undefined && message.method === undefined) {
    return null;
  }
  if (message.error !== undefined) {
    if (
      !message.error ||
      typeof message.error !== "object" ||
      Array.isArray(message.error)
    ) {
      return null;
    }
    const error = message.error as Record<string, unknown>;
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      return null;
    }
  }
  return parsed as RpcMessage;
}

export function codexEndpointFromLine(line: string): string | null {
  const plainText = stripVTControlCharacters(line);
  return /^\s*listening on:\s+(ws:\/\/\S+)\s*$/.exec(plainText)?.[1] ?? null;
}

export function codexStartupExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrLines: readonly string[],
): string {
  const status = signal ?? `code ${String(code)}`;
  const diagnostic = stderrLines
    .map((line) => stripVTControlCharacters(line).trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 2_000);
  return `Codex app-server exited before listening (${status})${diagnostic ? `: ${diagnostic}` : "."}`;
}

/** A received native JSON-RPC rejection, distinct from uncertain transport loss. */
export class CodexNativeRpcError extends Error {
  constructor(
    message: string,
    readonly nativeError: { code: number; message: string; data?: unknown },
    readonly requestMethod?: string,
  ) {
    super(message);
  }
}
