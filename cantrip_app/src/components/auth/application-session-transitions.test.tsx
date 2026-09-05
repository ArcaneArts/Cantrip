import type { ServerBootstrap, UserSummary } from "@cantrip/protocol";
import type { ClientEncryptionAccess } from "@/lib/account-encryption";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  prepare: vi.fn<(...args: unknown[]) => Promise<ClientEncryptionAccess>>(),
  session: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/lib/account-encryption", () => ({
  prepareClientEncryption: dependencies.prepare,
  confirmAnonymousRecoveryArtifactSaved: vi.fn(),
  recoverAnonymousClientEncryption: vi.fn(),
}));
vi.mock("@/lib/client-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-session")>()),
  setClientSession: dependencies.session,
  clearClientSession: dependencies.clear,
  onAuthenticationRequired: () => () => {},
  notifyAuthenticationRequired: vi.fn(),
  authenticationRequiredAction: () => "refresh-encryption",
}));
vi.mock("@/lib/anonymous-recovery-artifact", () => ({
  serializeAnonymousRecoveryArtifact: () => "synthetic recovery artifact",
  saveAnonymousRecoveryArtifact: vi.fn(),
}));
vi.mock("@/lib/runtime-platform", () => ({
  detectClientRuntimePlatform: () => "browser",
}));
vi.mock("@/router", () => ({ router: {} }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getAuthSession: vi.fn(),
  getServerBootstrap: vi.fn(),
  login: vi.fn(),
  registerAccount: vi.fn(),
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  operationalErrorMetadata: () => ({}),
}));

import { encryptionSessionState } from "./application-session";

const context = {
  bootstrap: {
    auth: { mode: "none" },
    server: { id: "fixture-server" },
  } as ServerBootstrap,
  csrfToken: null,
  expiresAt: null,
  user: { id: "fixture-owner" } as UserSummary,
};
const authenticated = { ...context, kind: "authenticated" as const };
const accessCases: {
  name: string;
  access: ClientEncryptionAccess;
  expected: object;
}[] = [
  {
    name: "anonymous setup",
    access: {
      status: "recovery-artifact-required",
      confirmationId: "new-confirmation",
      artifact: {} as Extract<
        ClientEncryptionAccess,
        { status: "recovery-artifact-required" }
      >["artifact"],
    },
    expected: {
      kind: "anonymous-recovery-setup-required",
      artifactText: "synthetic recovery artifact",
      confirmationId: "new-confirmation",
    },
  },
  {
    name: "anonymous recovery",
    access: {
      status: "recovery-required",
      message: "Restore the existing account",
      reason: "anonymous-device-missing",
    },
    expected: {
      kind: "encryption-recovery-required",
      message: "Restore the existing account",
      reason: "anonymous-device-missing",
    },
  },
  {
    name: "device recovery",
    access: {
      status: "credential-required",
      credential: "password",
      reason: "recover-device",
    },
    expected: {
      kind: "encryption-device-recovery-required",
      deviceLabel: "browser",
      error: null,
    },
  },
];

beforeEach(() => vi.clearAllMocks());
describe("application encryption session transitions", () => {
  it.each(accessCases)(
    "transitions an actual authenticated session to $name",
    async ({ access, expected }) => {
      dependencies.prepare.mockResolvedValueOnce(access);
      const result = await encryptionSessionState(authenticated);
      expect(result).toEqual({ ...context, ...expected });
      expect(dependencies.prepare).toHaveBeenCalledWith({
        authMode: "none",
        identity: { ownerId: "fixture-owner", serverId: "fixture-server" },
        password: undefined,
      });
      expect(dependencies.clear).not.toHaveBeenCalled();
    },
  );
  it.each([
    "anonymous-recovery-setup-required",
    "encryption-recovery-required",
    "encryption-device-recovery-required",
    "encryption-error",
  ])("returns %s to ready without retaining old state fields", async (kind) => {
    dependencies.prepare.mockResolvedValueOnce({ status: "ready" });
    const prior = {
      ...context,
      kind,
      artifactText: "retired artifact",
      confirmationId: "retired confirmation",
      message: "old failure",
      reason: "anonymous-device-missing",
      error: "old device failure",
      deviceLabel: "installation",
    };
    expect(await encryptionSessionState(prior)).toEqual({
      ...context,
      kind: "authenticated",
    });
  });
  it("replaces stale recovery details when a retry enters a different recovery state", async () => {
    dependencies.prepare.mockResolvedValueOnce(accessCases[1]!.access);
    const prior = {
      ...context,
      kind: "encryption-error",
      message: "old error",
      artifactText: "old artifact",
      confirmationId: "old confirmation",
      reason: "anonymous-binding-missing",
    };
    expect(await encryptionSessionState(prior)).toEqual({
      ...context,
      ...accessCases[1]!.expected,
    });
  });
  it("keeps credential authorization required and forwards the explicit password", async () => {
    dependencies.prepare.mockResolvedValueOnce({
      status: "credential-required",
      credential: "password",
      reason: "authorize-device",
    });
    const result = await encryptionSessionState(
      authenticated,
      "synthetic password",
    );
    expect(result.kind).toBe("signed-out");
    expect(dependencies.clear).toHaveBeenCalledOnce();
    expect(dependencies.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ password: "synthetic password" }),
    );
  });
});
