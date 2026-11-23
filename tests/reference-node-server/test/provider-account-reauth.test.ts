import { PROVIDER_REAUTH_REQUIRED_MESSAGE } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  isProviderAccountReauthenticationRequired,
  markProviderAccountReauthenticationRequired,
} from "../src/models/provider-account-reauth.js";

const input = {
  accountId: "account-one",
  ownerId: "owner-one",
  providerId: "provider-one",
};

function credential(state: "conflict" | "reauth-required" | "signed-in") {
  return {
    accountId: input.accountId,
    credential: {} as never,
    metadata: { expiresAt: null },
    providerId: input.providerId,
    providerKind: "chatgpt" as const,
    revision: 7,
    state,
    updatedAt: null,
  };
}

describe("provider account reauthentication", () => {
  it("recognizes only the safe worker reconnect signal", () => {
    expect(
      isProviderAccountReauthenticationRequired(
        new Error(PROVIDER_REAUTH_REQUIRED_MESSAGE),
      ),
    ).toBe(true);
    expect(
      isProviderAccountReauthenticationRequired(
        new Error("401 Unauthorized: raw upstream body"),
      ),
    ).toBe(false);
  });

  it("moves a signed-in credential to reauth-required at its exact revision", async () => {
    const repository = {
      getModelProviderAccountCredential: vi
        .fn()
        .mockResolvedValue(credential("signed-in")),
      updateModelProviderAccountCredentialState: vi
        .fn()
        .mockResolvedValue(true),
    };

    await expect(
      markProviderAccountReauthenticationRequired(repository, input),
    ).resolves.toBe(true);
    expect(
      repository.updateModelProviderAccountCredentialState,
    ).toHaveBeenCalledWith({
      ...input,
      expectedRevision: 7,
      state: "reauth-required",
    });
  });

  it("leaves missing, conflicting, and already-expired credentials unchanged", async () => {
    for (const value of [
      null,
      credential("conflict"),
      credential("reauth-required"),
    ]) {
      const update = vi.fn().mockResolvedValue(true);
      const repository = {
        getModelProviderAccountCredential: vi.fn().mockResolvedValue(value),
        updateModelProviderAccountCredentialState: update,
      };
      await markProviderAccountReauthenticationRequired(repository, input);
      expect(update).not.toHaveBeenCalled();
    }
  });
});
