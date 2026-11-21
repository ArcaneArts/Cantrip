import {
  cantripCliCommandResultSchema,
  workerCliCommandCallSchema,
  type CantripCliCommandRequest,
  type CantripCliCommandResult,
} from "@cantrip/protocol";

export class CantripServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export async function invokeCantripCliCommand(options: {
  chatContext?: {
    chatId: string;
    executionLaneId: string;
  } | null;
  request: CantripCliCommandRequest;
  requestId: string;
  serverUrl: string;
  token: string;
  workerId: string;
}): Promise<CantripCliCommandResult> {
  const url = new URL("/api/internal/cli", options.serverUrl);
  const call = workerCliCommandCallSchema.parse({
    ...options.request,
    chatContext: options.chatContext ?? null,
    requestId: options.requestId,
    workerId: options.workerId,
  });
  const context =
    call.context.selection === "auto"
      ? {
          codexThreadId: call.context.codexThreadId,
          terminalId: call.context.terminalId,
          cwd: call.context.cwd,
        }
      : call.context;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    // Older servers use a strict context schema from before explicit context
    // selection existed. Omitting the default preserves rolling-upgrade
    // compatibility while current servers restore `auto` from their default.
    body: JSON.stringify({ ...call, context }),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    throw new CantripServerRequestError(
      typeof record?.error === "string"
        ? record.error
        : `Cantrip CLI command failed with HTTP ${response.status}.`,
      response.status,
      typeof record?.code === "string" ? record.code : null,
    );
  }
  return cantripCliCommandResultSchema.parse(payload);
}
