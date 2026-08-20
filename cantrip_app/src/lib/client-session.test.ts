import { describe, expect, it } from "vitest";

import {
  clientSessionForRuntime,
  type ClientSessionContext,
} from "./client-session";

const session: ClientSessionContext = {
  authMode: "accounts",
  csrfToken: "c".repeat(32),
  expiresAt: "2026-08-20T13:00:00.000Z",
  serverId: "server-a",
  user: {
    id: "owner-a",
    kind: "account",
    displayName: "Owner A",
    email: "owner-a@example.com",
    role: "owner",
  },
};

describe("client session runtime", () => {
  it("preserves the authenticated identity across development hot reloads", () => {
    const hotState: Parameters<typeof clientSessionForRuntime>[0] = {};
    const mountedApplication = clientSessionForRuntime(hotState);
    mountedApplication.session = session;

    const reloadedWorkspaceCaller = clientSessionForRuntime(hotState);

    expect(reloadedWorkspaceCaller).toBe(mountedApplication);
    expect(reloadedWorkspaceCaller.session).toEqual(session);
  });
});
