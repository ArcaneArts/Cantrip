import {
  agentExecutionToolCallSchema,
  agentExecutionToolResultSchema,
  agentWorktreeToolCallSchema,
  agentWorktreeToolResultSchema,
  type AgentExecutionToolName,
  type AgentExecutionToolResult,
  type AgentWorktreeToolName,
  type AgentWorktreeToolResult,
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

interface InvokeExecutionToolOptions<TTool extends AgentExecutionToolName> {
  arguments: Record<string, unknown>;
  callId: string;
  chatId: string;
  executionLaneId: string;
  serverUrl: string;
  token: string;
  tool: TTool;
  workerId: string;
}

async function invokeCantripAgentTool<TResult>(options: {
  call: unknown;
  path: string;
  result(payload: unknown): TResult;
  serverUrl: string;
  token: string;
  errorLabel: string;
}): Promise<TResult> {
  const url = new URL(options.path, options.serverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(options.call),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `${options.errorLabel} failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return options.result(payload);
}

export async function invokeCantripCliCommand(options: {
  request: CantripCliCommandRequest;
  requestId: string;
  serverUrl: string;
  token: string;
  workerId: string;
}): Promise<CantripCliCommandResult> {
  const url = new URL("/api/internal/cli", options.serverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      workerCliCommandCallSchema.parse({
        ...options.request,
        requestId: options.requestId,
        workerId: options.workerId,
      }),
    ),
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

export async function invokeCantripExecutionTool(
  options: InvokeExecutionToolOptions<AgentExecutionToolName>,
): Promise<AgentExecutionToolResult> {
  return invokeCantripAgentTool({
    call: agentExecutionToolCallSchema.parse(options),
    path: options.tool.startsWith("cantrip_worktree")
      ? "/api/internal/agent-tools/worktree"
      : "/api/internal/agent-tools/execution",
    result: (payload) => agentExecutionToolResultSchema.parse(payload),
    serverUrl: options.serverUrl,
    token: options.token,
    errorLabel: "Cantrip execution tool",
  });
}

export async function invokeCantripWorktreeTool(
  options: InvokeExecutionToolOptions<AgentWorktreeToolName>,
): Promise<AgentWorktreeToolResult> {
  return invokeCantripAgentTool({
    call: agentWorktreeToolCallSchema.parse(options),
    path: "/api/internal/agent-tools/worktree",
    result: (payload) => agentWorktreeToolResultSchema.parse(payload),
    serverUrl: options.serverUrl,
    token: options.token,
    errorLabel: "Cantrip worktree tool",
  });
}
