import { describe, expect, it } from "vitest";

import {
  codeInstallVsixResultSchema,
  codeOpenExtensionsRequestSchema,
  codeOpenExtensionsResultSchema,
  codeOpenSettingsRequestSchema,
  codeOpenSettingsResultSchema,
  codePresentationUpdateSchema,
  codeSettingsWorkbenchAttachmentCreateSchema,
  workerCommandSchema,
} from "../src/index.js";

const tunnelId = "11111111-1111-4111-8111-111111111111";

describe("Code settings workbench protocol", () => {
  it("binds the settings workbench command to one global profile", () => {
    expect(
      workerCommandSchema.parse({
        type: "code.settings.workbench.open",
        sessionId: "22222222-2222-4222-8222-222222222222",
        profileId: "profile-1",
        appearance: "dark",
      }),
    ).toMatchObject({
      type: "code.settings.workbench.open",
      profileId: "profile-1",
    });
  });

  it("requires a tunnel-bound first protected record", () => {
    const input = {
      appearance: "dark",
      expectedWorkerId: "worker-1",
      tunnelId,
      sessionId: "22222222-2222-4222-8222-222222222222",
      protectedRecord: {
        operationId: tunnelId,
        revision: 1,
        protectedContent: {
          formatVersion: 1,
          domain: "tunnel-content",
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      },
    };
    expect(codeSettingsWorkbenchAttachmentCreateSchema.parse(input)).toEqual(
      input,
    );
    expect(
      codeSettingsWorkbenchAttachmentCreateSchema.safeParse({
        ...input,
        expectedWorktreeId: "not-allowed",
      }).success,
    ).toBe(false);
    expect(
      codeSettingsWorkbenchAttachmentCreateSchema.safeParse({
        ...input,
        protectedRecord: {
          ...input.protectedRecord,
          operationId: "33333333-3333-4333-8333-333333333333",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps authenticated open-settings control strict", () => {
    expect(codeOpenSettingsRequestSchema.parse({})).toEqual({});
    expect(
      codeOpenSettingsRequestSchema.safeParse({ extra: true }).success,
    ).toBe(false);
    expect(codeOpenSettingsResultSchema.parse({ opened: true })).toEqual({
      opened: true,
    });
  });

  it("keeps authenticated open-extensions control strict", () => {
    expect(codeOpenExtensionsRequestSchema.parse({})).toEqual({});
    expect(
      codeOpenExtensionsRequestSchema.safeParse({ extra: true }).success,
    ).toBe(false);
    expect(codeOpenExtensionsResultSchema.parse({ opened: true })).toEqual({
      opened: true,
    });
  });

  it("keeps authenticated VSIX installation acknowledgements strict", () => {
    expect(codeInstallVsixResultSchema.parse({ installed: true })).toEqual({
      installed: true,
    });
    expect(
      codeInstallVsixResultSchema.safeParse({ installed: false }).success,
    ).toBe(false);
  });

  it("represents the worker-authoritative Extensions presentation", () => {
    expect(
      codePresentationUpdateSchema.parse({ presentation: "extensions" }),
    ).toEqual({ presentation: "extensions" });
  });
});
