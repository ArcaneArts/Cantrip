// Execute the Source authority functions; no native metadata drives outcomes.
import {
  assertCantripMcpBinding,
  cantripMcpBindingReadiness,
} from "../../tests/reference-node-server/src/agent-tools/binding.ts";
import { effectivePermissionProfile } from "../../tests/reference-node-server/src/chats/execution-helpers.ts";
import { operations } from "./agent-run-http-fixtures.mjs";
import {
  CANTRIP_MCP_OPERATIONS,
  isCantripMcpMutationOperation,
} from "../../packages/protocol/dist/index.js";

const now = Date.parse("2026-11-05T00:00:00.000Z");
const selected = process.argv.includes("--all-operations")
  ? CANTRIP_MCP_OPERATIONS
  : operations;
const serverAllowedOperations = new Set([...selected, "context.get"]);
const cases = [];
for (const operation of selected)
  for (const profile of [":workspace", ":read-only", ":custom", null])
    for (const kind of ["project", "standalone"]) {
      const context = {
        contextKind: kind,
        chatId: "chat",
        projectId: kind === "project" ? "project" : null,
        scratchRootId: kind === "project" ? null : "scratch",
        workerId: "worker",
        executionLaneId: "lane",
        worktreeId: kind === "project" ? "tree" : null,
        rootKind: kind === "project" ? "git-worktree" : null,
        status: "running",
        permissionProfileId: profile,
        defaultPermissionProfileId: null,
        isPrimary: false,
        worktreePolicy: "agent-managed",
        nativePermissionPolicy: null,
      };
      const binding = {
        ...context,
        ownerId: "owner",
        bindingId: "eeeeeeee-eeee-4eee-8eee-000000000710",
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        allowedOperations: [operation, "context.get"],
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 120000).toISOString(),
      };
      for (const variant of [
        "current",
        "owner",
        "grant",
        "contextKind",
        "chatId",
        "projectId",
        "scratchRootId",
        "workerId",
        "executionLaneId",
        "worktreeId",
        "rootKind",
        "permissionProfileId",
        "all scope",
        "idle",
        "failed",
        "approval",
        "issue boundary",
        "future issue",
        "expired",
      ]) {
        const c = structuredClone(context),
          b = structuredClone(binding);
        if (variant === "owner") b.ownerId = "other";
        else if (variant === "grant") b.allowedOperations = ["context.get"];
        else if (variant === "all scope")
          Object.assign(b, {
            executionLaneId: "old",
            worktreeId: "old",
            rootKind: "old",
            permissionProfileId: "old",
          });
        else if (variant === "idle" || variant === "failed") c.status = variant;
        else if (variant === "approval") c.status = "waiting-for-approval";
        else if (variant === "issue boundary")
          b.issuedAt = new Date(now + 60000).toISOString();
        else if (variant === "future issue")
          b.issuedAt = new Date(now + 60001).toISOString();
        else if (variant === "expired")
          b.expiresAt = new Date(now).toISOString();
        else if (variant !== "current") b[variant] = "changed";
        let outcome;
        try {
          assertCantripMcpBinding({
            binding: b,
            context: c,
            operation,
            ownerId: "owner",
            serverAllowedOperations,
            now,
          });
          outcome = { ok: true };
        } catch (error) {
          outcome = {
            status: error.status,
            code: error.code,
            message: error.message,
          };
        }
        cases.push({
          operation,
          variant,
          context: c,
          binding: b,
          permission: effectivePermissionProfile(c).effectiveId,
          outcome,
          readiness: cantripMcpBindingReadiness({
            binding: b,
            context: c,
            serverAllowedOperations,
          }),
        });
      }
    }
process.stdout.write(
  JSON.stringify({
    now,
    operations: CANTRIP_MCP_OPERATIONS,
    mutations: CANTRIP_MCP_OPERATIONS.filter(isCantripMcpMutationOperation),
    cases,
  }),
);
