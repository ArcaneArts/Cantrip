import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { installExplorerOperationRoute } from "../src/app/routes/explorer-runtime.js";

describe("Explorer file operation binding", () => {
  it("validates the actual checkout before dispatch and keeps legacy operations compatible", async () => {
    const app = Fastify();
    const context = {
      explorerId: randomUUID(),
      projectId: randomUUID(),
      worktreeId: randomUUID(),
      workerId: "worker-one",
      root: "/disposable/worktree-one",
    };
    const payload = {
      operationId: randomUUID(),
      sequence: 0,
      protectedRequest: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    const request = vi.fn().mockResolvedValue({
      operationId: payload.operationId,
      sequence: 0,
      protectedResponse: payload.protectedRequest,
    });
    installExplorerOperationRoute(app, {
      applicationOwnerId: () => "owner",
      bridge: { request },
      repository: {
        getExplorerExecutionContext: vi.fn().mockResolvedValue(context),
      },
      serverId: randomUUID(),
    });
    const binding = {
      workerId: context.workerId,
      projectId: context.projectId,
      worktreeId: context.worktreeId,
    };
    try {
      for (const stale of [
        { ...binding, workerId: "previous-worker" },
        { ...binding, projectId: randomUUID() },
        { ...binding, worktreeId: randomUUID() },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/explorers/${context.explorerId}/operation`,
          payload: { ...payload, binding: stale },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().error).toContain("another checkout");
      }
      expect(request).not.toHaveBeenCalled();
      for (const body of [{ ...payload, binding }, payload]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/explorers/${context.explorerId}/operation`,
          payload: body,
        });
        expect(response.statusCode, response.body).toBe(200);
      }
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith(
        context.workerId,
        expect.objectContaining({
          root: context.root,
          explorerId: context.explorerId,
        }),
      );
      expect(request.mock.calls[0]![1]).not.toHaveProperty("binding");
    } finally {
      await app.close();
    }
  });
});
