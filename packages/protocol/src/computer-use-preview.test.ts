import { describe, expect, it } from "vitest";
import {
  cuaPreviewAuthoritySchema,
  cuaPreviewBindingSchema,
  cuaPreviewLeaseSchema,
  cuaPreviewRevocationSchema,
  cuaPreviewStopSchema,
  cuaApprovalTerminalSchema,
} from "./computer-use-preview.js";
import {
  workerCommandSchema,
  workerEventSchema,
  workerNotificationSchema,
} from "./index.js";

const authority = {
  ownerId: "owner",
  serverId: "server",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project",
  placementId: "worktree",
  generation: 1,
  profile: {
    selectedId: "yolo",
    effectiveId: "read-only",
    forcedByWorktreePolicy: true,
    usesDefault: false,
  },
};
const leaseId = "4822bfb8-0f60-4de4-a8e4-335c4099d61f";

describe("CUA preview authority contracts", () => {
  it("carries server-derived placement and profiles without fabricated native turn fields", () => {
    expect(cuaPreviewAuthoritySchema.parse(authority)).toEqual(authority);
    expect(cuaPreviewBindingSchema.parse({ leaseId, authority })).toEqual({
      leaseId,
      authority,
    });
    for (const field of [
      "threadId",
      "turnId",
      "taskId",
      "executionLaneId",
      "title",
      "pixels",
    ]) {
      expect(
        cuaPreviewAuthoritySchema.safeParse({
          ...authority,
          [field]: "client-choice",
        }).success,
      ).toBe(false);
    }
    expect(
      cuaPreviewAuthoritySchema.safeParse({
        ...authority,
        profile: { ...authority.profile, approvalPolicy: "never" },
      }).success,
    ).toBe(false);
  });
  it.each([0, -1, 1.5, 2_147_483_648, NaN, Infinity])(
    "rejects invalid durable generation %s",
    (generation) => {
      expect(
        cuaPreviewAuthoritySchema.safeParse({ ...authority, generation })
          .success,
      ).toBe(false);
      expect(
        cuaPreviewLeaseSchema.safeParse({
          leaseId,
          workerId: "worker",
          chatId: "chat",
          generation,
        }).success,
      ).toBe(false);
    },
  );
  it("bounds identifiers and accepts genuine standalone placement", () => {
    expect(
      cuaPreviewAuthoritySchema.parse({
        ...authority,
        contextKind: "standalone",
        projectId: null,
        placementId: "scratch",
      }).projectId,
    ).toBeNull();
    for (const field of [
      "ownerId",
      "serverId",
      "workerId",
      "chatId",
      "placementId",
    ]) {
      for (const value of ["", "x".repeat(10_000)])
        expect(
          cuaPreviewAuthoritySchema.safeParse({ ...authority, [field]: value })
            .success,
        ).toBe(false);
    }
    expect(cuaPreviewStopSchema.parse({ leaseId, workerId: "worker" })).toEqual(
      { leaseId, workerId: "worker" },
    );
    expect(
      cuaPreviewStopSchema.safeParse({
        leaseId: "not-uuid",
        workerId: "worker",
      }).success,
    ).toBe(false);
    expect(
      cuaPreviewStopSchema.safeParse({ leaseId, workerId: "worker", all: true })
        .success,
    ).toBe(false);
  });
  it("registers exact open/stop/revoke worker commands", () => {
    expect(
      workerCommandSchema.parse({
        type: "computer-use.preview.open",
        authority,
      }),
    ).toEqual({ type: "computer-use.preview.open", authority });
    expect(
      workerCommandSchema.parse({
        type: "computer-use.preview.stop",
        ownerId: "owner",
        serverId: "server",
        chatId: "chat",
        leaseId,
      }).type,
    ).toBe("computer-use.preview.stop");
    for (const scope of [
      { kind: "chat", chatId: "chat" },
      { kind: "project", projectId: "project" },
      { kind: "inherited-default", contextKind: "standalone" },
    ]) {
      expect(cuaPreviewRevocationSchema.parse(scope)).toEqual(scope);
      expect(
        workerCommandSchema.parse({
          type: "computer-use.preview.revoke",
          ownerId: "owner",
          serverId: "server",
          scope,
        }).type,
      ).toBe("computer-use.preview.revoke");
    }
    expect(cuaPreviewRevocationSchema.safeParse({ kind: "all" }).success).toBe(
      false,
    );
  });
  it("uses the same bounded terminal contract in ordered events and notifications", () => {
    for (const status of ["expired", "interrupted"]) {
      const terminal = {
        type: "computer-use.approval.terminal",
        chatId: "chat",
        requestKey: leaseId,
        status,
      };
      expect(cuaApprovalTerminalSchema.parse(terminal)).toEqual(terminal);
      expect(workerEventSchema.parse(terminal)).toEqual(terminal);
      expect(workerNotificationSchema.parse(terminal)).toEqual(terminal);
    }
    expect(
      cuaApprovalTerminalSchema.safeParse({
        type: "computer-use.approval.terminal",
        chatId: "chat",
        requestKey: leaseId,
        status: "resolved",
      }).success,
    ).toBe(false);
  });
});
