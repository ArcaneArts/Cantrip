import type { FastifyRequest } from "fastify";

import { TUNNEL_BROWSER_PROTOCOL_PREFIX } from "./constants.js";

const UUID_PATH_PARAMETER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validUuidPathParameter(value: string): boolean {
  return UUID_PATH_PARAMETER_PATTERN.test(value);
}

export function tunnelAttachmentSocketSecret(headers: {
  authorization?: string;
  "sec-websocket-protocol"?: string;
}): string {
  if (headers.authorization?.startsWith("Bearer ")) {
    return headers.authorization.slice("Bearer ".length);
  }
  const protocol = headers["sec-websocket-protocol"]
    ?.split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(TUNNEL_BROWSER_PROTOCOL_PREFIX));
  return protocol?.slice(TUNNEL_BROWSER_PROTOCOL_PREFIX.length) ?? "";
}

export function mutationAuditDescriptor(
  method: string,
  route: string,
): { action: string; resourceType: string } | null {
  if (route.startsWith("/api/encryption") && method !== "GET") {
    return {
      action: "encryption.registry-changed",
      resourceType: "encryption-registry",
    };
  }
  if (route.startsWith("/api/admin/license-whitelist") && method !== "GET") {
    return {
      action: "account-license.configuration-changed",
      resourceType: "account-license",
    };
  }
  if (method === "GET" && route === "/api/projects/:projectId/chats") {
    return { action: "project.accessed", resourceType: "project" };
  }
  if (method === "POST" && route === "/api/workers/enrollment-codes") {
    return { action: "worker.pairing-code-created", resourceType: "worker" };
  }
  if (
    method === "POST" &&
    route === "/api/run-configuration-runtimes/operations"
  ) {
    return {
      action: "run.configuration.lifecycle-requested",
      resourceType: "run-configuration-runtime",
    };
  }
  if (route.startsWith("/api/workers/") && method !== "GET") {
    return { action: "worker.configuration-changed", resourceType: "worker" };
  }
  if (
    (route.startsWith("/api/settings/providers") ||
      route.includes("/mcp-servers")) &&
    method !== "GET"
  ) {
    return { action: "secret.configuration-changed", resourceType: "secret" };
  }
  if (route.includes("/git/") && method !== "GET") {
    return { action: "git.operation-requested", resourceType: "project" };
  }
  if (route.includes("/replica") && method !== "GET") {
    return {
      action: "project-replica.configuration-changed",
      resourceType: "project-replica",
    };
  }
  if (route.startsWith("/api/projects") && method !== "GET") {
    return { action: "project.configuration-changed", resourceType: "project" };
  }
  return null;
}

export function auditResourceId(request: FastifyRequest): string | null {
  if (!request.params || typeof request.params !== "object") return null;
  const params = request.params as Record<string, unknown>;
  for (const key of [
    "grantId",
    "principalId",
    "credentialId",
    "workerId",
    "providerId",
    "policyId",
    "serverId",
    "projectReplicaId",
    "replicaId",
    "projectId",
  ]) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function publicRoute(route: string): boolean {
  return (
    route === "/api" ||
    route === "/version" ||
    route === "/healthz" ||
    route === "/readyz" ||
    route === "/metrics" ||
    route === "/api/bootstrap" ||
    route === "/api/auth/login" ||
    route === "/api/auth/register" ||
    route === "/api/auth/mobile-sign-in/exchange" ||
    route === "/api/auth/session" ||
    route.startsWith("/api/internal/") ||
    route === "/api/tunnel-attachments/:attachmentId/connect"
  );
}

export function csrfExemptRoute(route: string): boolean {
  return publicRoute(route) || route === "/api/auth/session";
}

export function removedPlaintextRepositoryRoute(route: string): boolean {
  const projectRoute = route.startsWith("/api/projects/:projectId/");
  const legacyGitRoute =
    projectRoute &&
    route.includes("/git/") &&
    !route.endsWith("/git/agent/drafts");
  const legacyHistoryRoute =
    projectRoute && (route.endsWith("/history") || route.includes("/history/"));
  const legacyGithubContentRoute =
    projectRoute &&
    (route.includes("/github/issues") ||
      route.includes("/github/releases") ||
      route.includes("/github/pull-requests"));
  const legacyGithubCatalogRoute = route.startsWith("/api/github/");
  const legacyWorktreeStatusRoute =
    projectRoute && route.endsWith("/worktrees/:worktreeId/status");
  return (
    legacyGitRoute ||
    legacyHistoryRoute ||
    legacyGithubContentRoute ||
    legacyGithubCatalogRoute ||
    legacyWorktreeStatusRoute
  );
}

export function standaloneChatFeatureForbidden(route: string): boolean {
  return (
    route === "/api/chats/:chatId/console" ||
    route === "/api/chats/:chatId/goal" ||
    route === "/api/chats/:chatId/plan" ||
    route === "/api/chats/:chatId/relocations" ||
    route === "/api/chats/:chatId/skills" ||
    route === "/api/chats/:chatId/sync" ||
    route === "/api/chats/:chatId/worktree" ||
    route.startsWith("/api/chats/:chatId/customizations") ||
    route.startsWith("/api/chats/:chatId/execution-lanes")
  );
}
