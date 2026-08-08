import {
  agentWorktreeToolCallSchema,
  agentWorktreeToolResultSchema,
  type AgentWorktreeToolName,
  type AgentWorktreeToolResult,
} from "@cantrip/protocol";

interface InvokeWorktreeToolOptions {
  arguments: Record<string, unknown>;
  callId: string;
  chatId: string;
  executionLaneId: string;
  serverUrl: string;
  token: string;
  tool: AgentWorktreeToolName;
  workerId: string;
}

export async function invokeCantripWorktreeTool(
  options: InvokeWorktreeToolOptions,
): Promise<AgentWorktreeToolResult> {
  const url = new URL("/api/internal/agent-tools/worktree", options.serverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      agentWorktreeToolCallSchema.parse({
        arguments: options.arguments,
        callId: options.callId,
        chatId: options.chatId,
        executionLaneId: options.executionLaneId,
        tool: options.tool,
        workerId: options.workerId,
      }),
    ),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `Cantrip worktree tool failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return agentWorktreeToolResultSchema.parse(payload);
}
