import { generateAccountMasterKey } from "@cantrip/crypto";
import {
  projectWorktreeSummarySchema,
  repositoryOperationOutcomeContentSchema,
  repositoryOperationRequestContentSchema,
  workerSummarySchema,
  type ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectWorktrees } from "./api";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import {
  openRepositoryOperationContent,
  protectRepositoryOperationContent,
} from "./repository-operation-encryption";

const timestamp = "2026-10-08T12:00:00.000Z";
const workerId = "folder-worker";
const privatePath = "/private/worker/folders/authorized-root";
let projectId: string;
beforeEach(() => {
  projectId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId: "folder-server",
    user: {
      id: ownerId,
      kind: "account",
      displayName: "QA",
      email: "qa@example.test",
      role: "member",
    },
  });
  clientEncryption.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId: "folder-server" },
    masterKeyRevision: 1,
  });
});
afterEach(() => {
  clientEncryption.lock();
  clearClientSession();
  vi.unstubAllGlobals();
});

function fixture(
  options: {
    rootKind?: ProjectWorktreeSummary["rootKind"];
    lifecycleState?: ProjectWorktreeSummary["lifecycleState"];
    origin?: ProjectWorktreeSummary["origin"];
    failure?: "unauthorized" | "offline" | "wrong context" | "missing path";
  } = {},
) {
  const root = projectWorktreeSummarySchema.parse({
    id: crypto.randomUUID(),
    projectSourceId: crypto.randomUUID(),
    projectId,
    rootKind: options.rootKind ?? "folder-root",
    workerId,
    name: "Protected root",
    path: `ctrr_${"p".repeat(43)}`,
    displayPath: `ctrr_${"d".repeat(43)}`,
    isPrimary: true,
    isDefault: true,
    origin: options.origin ?? "cantrip",
    lifecycleState: options.lifecycleState ?? "ready",
    branch: null,
    head: null,
    detached: false,
    locked: false,
    lockReason: null,
    lastScannedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const worker = workerSummarySchema.parse({
    workerId,
    name: "Folder worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: null,
    startedAt: timestamp,
    lastSeenAt: timestamp,
    online: options.failure !== "offline",
    encryption: {
      supported: true,
      state: "ready",
      principalId: crypto.randomUUID(),
      grants: [{ component: "repository-content", keyRevision: 1 }],
      lastSyncedAt: timestamp,
      error: null,
    },
  });
  const operations: Array<{
    type: string;
    path: string;
    arguments: Record<string, unknown>;
    access: unknown;
  }> = [];
  const gitResult = {
    worktree: {
      path: "/private/worker/repository",
      head: "a".repeat(40),
      branch: "main",
      detached: false,
      isPrimary: true,
      managed: true,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      missing: false,
    },
    status: {
      branch: "main",
      head: "a".repeat(40),
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      branches: [],
    },
  };
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = String(url);
      if (pathname.endsWith(`/api/projects/${projectId}/worktrees`))
        return Response.json([root]);
      if (pathname.endsWith("/api/workers")) return Response.json([worker]);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(String(init.body)).not.toContain(privatePath);
        const scope = {
          projectId,
          worktreeId: pathname.includes("/api/workers/") ? workerId : root.id,
          operationId: body.operationId,
        };
        const content = await openRepositoryOperationContent({
          context: { ...scope, direction: "request" },
          opaque: body.protectedRequest,
          schema: repositoryOperationRequestContentSchema,
        });
        operations.push({
          type: content.type,
          path: pathname,
          arguments: content.arguments,
          access: body.access,
        });
        if (
          root.rootKind === "folder-root" &&
          content.type === "worktree.status"
        )
          return Response.json(
            {
              error: "Git is unavailable for a folder",
              code: "project-capability-unavailable",
            },
            { status: 409 },
          );
        if (options.failure === "unauthorized")
          return Response.json({ error: "Access denied" }, { status: 403 });
        const result =
          content.type === "worktree.status"
            ? gitResult
            : {
                values:
                  options.failure === "missing path"
                    ? { path: null, displayPath: null }
                    : {
                        path: privatePath,
                        displayPath: "folders/authorized-root",
                      },
              };
        const protectedResponse = await protectRepositoryOperationContent({
          context: {
            ...scope,
            worktreeId:
              options.failure === "wrong context"
                ? "another-worker"
                : scope.worktreeId,
            direction: "response",
          },
          content: { ok: true, result },
          schema: repositoryOperationOutcomeContentSchema,
        });
        return Response.json({
          operationId: body.operationId,
          protectedResponse,
        });
      }
      throw new Error(`Unexpected fixture route ${pathname}`);
    },
  );
  vi.stubGlobal("fetch", fetch);
  return { root, worker, operations, gitResult };
}

describe("folder root metadata through the encrypted client API", () => {
  it.each(["cantrip", "external"] as const)(
    "resolves %s folder paths without requesting or inventing Git status",
    async (origin) => {
      const { root, operations } = fixture({ origin });
      const onStatus = vi.fn();
      const result = await getProjectWorktrees(projectId, { onStatus });
      expect(result).toEqual([
        {
          ...root,
          name: "Primary",
          path: privatePath,
          displayPath: "folders/authorized-root",
        },
      ]);
      expect(operations).toEqual([
        {
          type: "repository.metadata.resolve",
          path: `/api/workers/${workerId}/repository-operation`,
          arguments: {
            values: { path: root.path, displayPath: root.displayPath },
          },
          access: "read",
        },
      ]);
      expect(onStatus).not.toHaveBeenCalled();
    },
  );

  it.each([
    "unauthorized",
    "offline",
    "wrong context",
    "missing path",
  ] as const)(
    "keeps %s metadata unavailable without exposing handles",
    async (failure) => {
      const { operations } = fixture({ failure });
      const [result] = await getProjectWorktrees(projectId);
      expect(result).toMatchObject({
        path: "Protected path unavailable",
        displayPath: "Protected path unavailable",
        branch: null,
      });
      expect(JSON.stringify(result)).not.toContain("ctrr_");
      if (failure === "offline") expect(operations).toEqual([]);
    },
  );

  it("does not resolve a missing folder root", async () => {
    const { operations } = fixture({ lifecycleState: "missing" });
    expect((await getProjectWorktrees(projectId))[0]?.path).toBe(
      "Protected path unavailable",
    );
    expect(operations).toEqual([]);
  });

  it("retains protected Git status and its cache callback for Git worktrees", async () => {
    const { root, operations, gitResult } = fixture({
      rootKind: "git-worktree",
    });
    const onStatus = vi.fn();
    const [result] = await getProjectWorktrees(projectId, { onStatus });
    expect(result).toMatchObject({
      path: gitResult.worktree.path,
      branch: "main",
      head: "a".repeat(40),
    });
    expect(operations.map(({ type }) => type)).toEqual(["worktree.status"]);
    expect(onStatus).toHaveBeenCalledWith(root.id, gitResult);
  });
});
