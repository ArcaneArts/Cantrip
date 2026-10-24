import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyWorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import {
  connectWorkspaceCommands,
  workspaceLayoutTransport,
} from "./api/workspace-layouts";
import { CantripApiError } from "./api-client";
import {
  clearClientSession,
  getClientSessionIdentitySnapshot,
  setClientSession,
} from "./client-session";

const layout: WorkspaceOwnership = {
  version: 1,
  id: "device/workspace",
  projectId: "project/id",
  revision: 0,
  mainWindowId: "main",
  windows: [
    {
      id: "main",
      attachmentGeneration: 0,
      panes: [],
      centerRoot: null,
      focusedPaneId: null,
      recentPaneIds: [],
    },
  ],
};
beforeEach(() =>
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId: "server",
    user: {
      id: "owner",
      kind: "account",
      displayName: "Owner",
      email: "owner@example.com",
      role: "member",
    },
  }),
);
afterEach(() => {
  clearClientSession();
  vi.unstubAllGlobals();
});
function transport() {
  return workspaceLayoutTransport(
    layout.projectId,
    layout.id,
    getClientSessionIdentitySnapshot()!,
  );
}

it("uses encoded workspace routes and validates the existing workspace snapshot", async () => {
  const fetcher = vi.fn(async (_url: unknown) => Response.json(layout));
  vi.stubGlobal("fetch", fetcher);
  expect(await transport().read()).toEqual(layout);
  expect(fetcher.mock.calls[0]![0]).toContain(
    "/api/projects/project%2Fid/workspace-layouts/device%2Fworkspace",
  );
});
it("pins delayed responses to their original authenticated lifetime", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const reading = transport().read();
  clearClientSession();
  finish(Response.json(layout));
  await expect(reading).rejects.toMatchObject({
    code: "client-identity-changed",
  });
});
it("rejects mismatched command scope before sending it", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    transport().execute({
      operationId: "op",
      workspaceId: "different",
      projectId: layout.projectId,
      windowId: "main",
      attachmentGeneration: 0,
      expectedRevision: 0,
      action: { type: "home" },
    }),
  ).rejects.toThrow("scope mismatch");
  expect(fetcher).not.toHaveBeenCalled();
});
it("distinguishes revision rejections from transport uncertainty", () => {
  const client = transport();
  expect(
    client.classify(new CantripApiError("conflict", 409, "revision")),
  ).toBe("conflict");
  expect(
    client.classify(new CantripApiError("stale renderer", 409, "attachment")),
  ).toBe("rejected");
  expect(client.classify(new CantripApiError("unavailable", 503))).toBe(
    "uncertain",
  );
  expect(client.classify(new TypeError("network"))).toBe("uncertain");
});
it("connects the command queue to the bound endpoint and disposes it on logout", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(layout);
    const command = JSON.parse(init.body as string);
    const result = applyWorkspaceCommand(layout, command);
    return Response.json({
      ...result,
      appliedRevision: result.layout.revision,
      replayed: false,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const connection = await connectWorkspaceCommands(
    layout.projectId,
    layout.id,
    "main",
  );
  await connection.controller.dispatch({ type: "home" });
  expect(connection.controller.getSnapshot().authoritative.revision).toBe(1);
  clearClientSession();
  await expect(
    connection.controller.dispatch({ type: "home" }),
  ).rejects.toThrow("disposed");
  expect(fetcher).toHaveBeenCalledTimes(2);
  connection.dispose();
});
