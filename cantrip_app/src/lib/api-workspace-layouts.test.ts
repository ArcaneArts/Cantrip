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

const legacyImport = {
  windowId: "cantrip-editor-old",
  paneId: "imported-pane",
  expectedRevision: 0,
  views: [
    { tabId: "imported-file", documentId: "document", mode: "edit" as const },
  ],
};

it("sends only validated import bindings over the account-bound workspace route", async () => {
  const receipt = { layout, replayed: true };
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.json(receipt),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await transport().importLegacyFiles(legacyImport)).toEqual(receipt);
  expect(fetcher.mock.calls[0]![0]).toContain(
    "/api/projects/project%2Fid/workspace-layouts/device%2Fworkspace/import-legacy-files",
  );
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(
    legacyImport,
  );
});

it("rejects an import acknowledgement after the account changes", async () => {
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
  const pending = transport().importLegacyFiles(legacyImport);
  clearClientSession();
  finish(Response.json({ layout, replayed: false }));
  await expect(pending).rejects.toMatchObject({
    code: "client-identity-changed",
  });
});

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

it.each(["logout", "renderer-end", "dispose"])(
  "releases attachment listeners and its connection exactly once after %s",
  async (cause) => {
    const ended = new AbortController();
    const releaseConnection = vi.fn();
    const removeListener = vi.spyOn(ended.signal, "removeEventListener");
    let current = structuredClone(layout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json(current);
        const result = applyWorkspaceCommand(
          current,
          JSON.parse(init.body as string),
        );
        current = result.layout;
        return Response.json({
          ...result,
          appliedRevision: current.revision,
          replayed: false,
        });
      }),
    );
    const connection = await connectWorkspaceCommands(
      layout.projectId,
      layout.id,
      "main",
      undefined,
      { rendererId: "renderer", signal: ended.signal, releaseConnection },
    );
    expect(
      connection.controller.getSnapshot().authoritative.windows[0],
    ).toMatchObject({
      rendererId: "renderer",
      attachmentGeneration: 1,
    });
    expect(releaseConnection).not.toHaveBeenCalled();
    if (cause === "logout") clearClientSession();
    else if (cause === "renderer-end") ended.abort(new Error("page ended"));
    else connection.dispose();
    expect(connection.controller.getSnapshot().disposed).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    clearClientSession();
    ended.abort();
    connection.dispose();
    connection.dispose();
    expect(releaseConnection).toHaveBeenCalledOnce();
  },
);

it("refreshes a second connection through an authorized read after a local commit", async () => {
  let current = structuredClone(layout);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(current);
    const command = JSON.parse(init.body as string);
    const result = applyWorkspaceCommand(current, command);
    current = result.layout;
    return Response.json({
      ...result,
      appliedRevision: current.revision,
      replayed: false,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const first = await connectWorkspaceCommands(
    layout.projectId,
    layout.id,
    "main",
  );
  const second = await connectWorkspaceCommands(
    layout.projectId,
    layout.id,
    "main",
  );
  try {
    await first.controller.dispatch({ type: "home" });
    await vi.waitFor(() => {
      expect(second.controller.getSnapshot().authoritative.revision).toBe(1);
    });
    // Two initial reads, one command, and the notified connection's read.
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(second.controller.getSnapshot().authoritative).toEqual(current);
  } finally {
    first.dispose();
    second.dispose();
  }
});

it("imports observations only after an actual missing workspace response", async () => {
  const observations = {
    mainWindowId: "main",
    detachedPanes: [],
    activeTabByPane: {},
  };
  const prepare = vi.fn(async () => observations);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json(layout)
      : Response.json({ error: "Workspace not found." }, { status: 404 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const connection = await connectWorkspaceCommands(
    layout.projectId,
    layout.id,
    "main",
    prepare,
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[1]![0]).toContain("/seed");
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual(
    observations,
  );
  connection.dispose();
});

it.each([403, 409, 500, 503])("does not seed after HTTP %i", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "failed" }, { status })),
  );
  const prepare = vi.fn(async () => ({ mainWindowId: "main" }));
  await expect(
    connectWorkspaceCommands(layout.projectId, layout.id, "main", prepare),
  ).rejects.toBeInstanceOf(CantripApiError);
  expect(prepare).not.toHaveBeenCalled();
});

it("does not seed when ownership already exists", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(layout)),
  );
  const prepare = vi.fn(async () => ({ mainWindowId: "main" }));
  const connection = await connectWorkspaceCommands(
    layout.projectId,
    layout.id,
    "main",
    prepare,
  );
  expect(prepare).not.toHaveBeenCalled();
  connection.dispose();
});

it("does not seed into a replacement account after delayed observation", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: "missing" }, { status: 404 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const prepare = async () => {
    clearClientSession();
    return { mainWindowId: "main" };
  };
  await expect(
    connectWorkspaceCommands(layout.projectId, layout.id, "main", prepare),
  ).rejects.toMatchObject({ code: "client-identity-changed" });
  expect(fetcher).toHaveBeenCalledOnce();
});
