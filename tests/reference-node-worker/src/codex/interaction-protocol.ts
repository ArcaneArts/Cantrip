import type {
  RpcMessage,
  ToolRequestUserInputParams,
} from "./runtime-types.js";
import type {
  AgentInteractionRequestKind,
  AgentInteractionResponse,
  AgentInteractionRuntimeRequest,
} from "@cantrip/protocol";
import {
  agentInteractionResponseSchema,
  agentInteractionRuntimeRequestSchema,
} from "@cantrip/protocol";

export function planQuestionId(
  params: Pick<ToolRequestUserInputParams, "threadId" | "turnId" | "itemId">,
  rpcId: number | string,
): string {
  return `${params.threadId}:${params.turnId}:${params.itemId}:${String(rpcId)}`;
}

export const AGENT_INTERACTION_TIMEOUT_MS = 30 * 60_000;

const AGENT_INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function rpcParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("App Server request params must be an object.");
  }
  return params as Record<string, unknown>;
}

function availableCommandDecisions(
  value: unknown,
): Array<
  | "accept"
  | "acceptForSession"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel"
> | null {
  if (!Array.isArray(value)) return null;
  const known: ReadonlySet<string> = new Set([
    "accept",
    "acceptForSession",
    "acceptWithExecpolicyAmendment",
    "applyNetworkPolicyAmendment",
    "decline",
    "cancel",
  ]);
  return value.flatMap((decision) => {
    if (typeof decision === "string" && known.has(decision)) {
      return [
        decision as
          | "accept"
          | "acceptForSession"
          | "acceptWithExecpolicyAmendment"
          | "applyNetworkPolicyAmendment"
          | "decline"
          | "cancel",
      ];
    }
    if (!decision || typeof decision !== "object") return [];
    if ("acceptWithExecpolicyAmendment" in decision) {
      return ["acceptWithExecpolicyAmendment"] as const;
    }
    if ("applyNetworkPolicyAmendment" in decision) {
      return ["applyNetworkPolicyAmendment"] as const;
    }
    return [];
  }) as ReturnType<typeof availableCommandDecisions>;
}

export function agentInteractionRequestFromServerRequest(
  method: string,
  params: unknown,
  requestKey: string,
  nowMs = Date.now(),
): AgentInteractionRuntimeRequest | null {
  if (!AGENT_INTERACTION_METHODS.has(method)) return null;
  const value = rpcParams(params);
  const requestedTimeout =
    method === "item/tool/requestUserInput" &&
    typeof value.autoResolutionMs === "number" &&
    Number.isSafeInteger(value.autoResolutionMs) &&
    value.autoResolutionMs >= 0
      ? value.autoResolutionMs
      : AGENT_INTERACTION_TIMEOUT_MS;
  const expiresAt = new Date(
    nowMs + Math.min(requestedTimeout, AGENT_INTERACTION_TIMEOUT_MS),
  ).toISOString();

  if (method === "item/commandExecution/requestApproval") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "commandExecution",
        startedAtMs: value.startedAtMs,
        approvalId: value.approvalId ?? null,
        environmentId: value.environmentId ?? null,
        reason: value.reason ?? null,
        command: value.command ?? null,
        cwd: value.cwd ?? null,
        commandActions: value.commandActions ?? null,
        networkApprovalContext: value.networkApprovalContext ?? null,
        additionalPermissions: value.additionalPermissions ?? null,
        proposedExecpolicyAmendment: value.proposedExecpolicyAmendment ?? null,
        proposedNetworkPolicyAmendments:
          value.proposedNetworkPolicyAmendments ?? null,
        availableDecisions: availableCommandDecisions(value.availableDecisions),
      },
    });
  }
  if (method === "item/fileChange/requestApproval") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "fileChange",
        startedAtMs: value.startedAtMs,
        reason: value.reason ?? null,
        grantRoot: value.grantRoot ?? null,
      },
    });
  }
  if (method === "item/permissions/requestApproval") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "permissions",
        startedAtMs: value.startedAtMs,
        environmentId: value.environmentId ?? null,
        cwd: value.cwd,
        reason: value.reason ?? null,
        requestedPermissions: value.permissions,
      },
    });
  }
  if (method === "item/tool/requestUserInput") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "userInput",
        questions: value.questions,
        autoResolutionMs: value.autoResolutionMs ?? null,
      },
    });
  }
  return agentInteractionRuntimeRequestSchema.parse({
    requestKey,
    threadId: value.threadId,
    turnId: value.turnId ?? null,
    itemId: null,
    expiresAt,
    payload: {
      kind: "mcpElicitation",
      serverName: value.serverName,
      mode: value.mode,
      message: value.message,
      requestedSchema: value.requestedSchema ?? null,
      url: value.url ?? null,
      elicitationId: value.elicitationId ?? null,
      metadata: value._meta ?? null,
    },
  });
}

/** Translate the accepted native reply for durable, encrypted GUI display. */
export function agentInteractionResponseFromNativeResult(
  kind: AgentInteractionRequestKind,
  result: unknown,
): AgentInteractionResponse | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return undefined;
  const value = result as Record<string, unknown>;
  const response: Record<string, unknown> = { ...value, kind };
  if (kind === "mcpElicitation") response.metadata = value._meta ?? null;
  if (
    kind === "commandExecution" &&
    value.decision &&
    typeof value.decision === "object"
  ) {
    const decision = value.decision as Record<
      string,
      { execpolicy_amendment?: unknown; network_policy_amendment?: unknown }
    >;
    if (decision.acceptWithExecpolicyAmendment) {
      response.decision = "acceptWithExecpolicyAmendment";
      response.execpolicyAmendment =
        decision.acceptWithExecpolicyAmendment.execpolicy_amendment;
    } else if (decision.applyNetworkPolicyAmendment) {
      response.decision = "applyNetworkPolicyAmendment";
      response.networkPolicyAmendment =
        decision.applyNetworkPolicyAmendment.network_policy_amendment;
    }
  }
  const parsed = agentInteractionResponseSchema.safeParse(response);
  return parsed.success ? parsed.data : undefined;
}

export function codexResultForAgentInteraction(
  response: AgentInteractionResponse,
): unknown {
  if (response.kind === "commandExecution") {
    if (response.decision === "acceptWithExecpolicyAmendment") {
      if (!response.execpolicyAmendment) {
        throw new Error("Missing execpolicy amendment.");
      }
      return {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: response.execpolicyAmendment,
          },
        },
      };
    }
    if (response.decision === "applyNetworkPolicyAmendment") {
      if (!response.networkPolicyAmendment) {
        throw new Error("Missing network policy amendment.");
      }
      return {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: response.networkPolicyAmendment,
          },
        },
      };
    }
    return { decision: response.decision };
  }
  if (response.kind === "fileChange") {
    return { decision: response.decision };
  }
  if (response.kind === "permissions") {
    return {
      permissions: response.permissions,
      scope: response.scope,
      strictAutoReview: response.strictAutoReview,
    };
  }
  if (response.kind === "userInput") {
    return { answers: response.answers };
  }
  return {
    action: response.action,
    content: response.content,
    _meta: response.metadata,
  };
}

export function failClosedAgentInteractionReply(
  kind: AgentInteractionRequestKind,
  reason: string,
): Pick<RpcMessage, "error" | "result"> {
  if (kind === "commandExecution" || kind === "fileChange") {
    return { result: { decision: "cancel" } };
  }
  if (kind === "permissions") {
    return {
      result: {
        permissions: {},
        scope: "turn",
        strictAutoReview: false,
      },
    };
  }
  if (kind === "mcpElicitation") {
    return { result: { action: "cancel", content: null, _meta: null } };
  }
  return { error: { code: -32_000, message: reason } };
}
