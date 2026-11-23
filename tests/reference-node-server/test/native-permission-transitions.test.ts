import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type NativeCommandAdmission,
  type NativeCommandReceipt,
  type NativeSettingsEvidence,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { resolvePermissionTransition } from "../src/db/repository/native-permission-transitions.js";
import { effectivePermissionProfile } from "../src/chats/execution-helpers.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
  await fixture.commands.refreshSettingsState(
    LOCAL_USER_ID,
    fixture.chatId,
    async (scope) => ({
      context: {
        chatId: scope.chatId,
        workerId: scope.workerId,
        threadId: scope.threadId,
        runtimeGeneration: "runtime-one",
        settingsVersion: { epoch: "native-epoch", revision: "0" },
      },
      protectedContent: settingsEnvelope,
      contentFingerprint: "c".repeat(64),
    }),
  );
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});
const context = async () =>
  (await fixture.repository.getChatExecutionContext(
    LOCAL_USER_ID,
    fixture.chatId,
  ))!;
const state = async () =>
  (await fixture.commands.settingsState(LOCAL_USER_ID, fixture.chatId))!;
async function input(
  selectedId: string | null,
  origin: "gui" | "terminal" = "terminal",
) {
  const value = await fixture.input(origin);
  value.intent.settingsBindingId = (await state()).binding!.bindingId;
  value.intent.settingKeys = ["permissions", "approvalPolicy"];
  value.intent.permissionTransition = resolvePermissionTransition(
    await context(),
    selectedId,
    (await state()).permissionPolicy?.revision ?? "0",
  );
  value.intent.permissionProfileId = effectivePermissionProfile(
    await context(),
  ).effectiveId;
  return value;
}
type Command = { input: NativeCommandAdmission; receipt: NativeCommandReceipt };
async function admit(
  selectedId: string | null,
  origin: "gui" | "terminal" = "terminal",
): Promise<Command> {
  const value = await input(selectedId, origin);
  const grant = await fixture.commands.admit(LOCAL_USER_ID, value);
  expect(grant.receipt.status).toBe("accepted");
  return { input: value, receipt: grant.receipt };
}
async function dispatch(command: Command) {
  return fixture.commands.dispatch(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    operationId: command.input.operationId,
    operationGeneration: command.receipt.operationGeneration,
    payloadDigest: command.input.payloadDigest,
    session: command.input.session,
  });
}
function evidence(
  command: Command,
  kind: NativeSettingsEvidence["kind"],
  revision: string,
): NativeSettingsEvidence {
  return {
    workerId: fixture.workerId,
    operationId: command.input.operationId,
    operationGeneration: command.receipt.operationGeneration,
    eventId: randomUUID(),
    threadId: command.input.session.threadId!,
    runtimeGeneration: command.input.session.runtimeGeneration!,
    nativeOperationId: command.input.intent.nativeSettingsOperationId!,
    submissionId: command.input.operationId,
    kind,
    resultDigest: "b".repeat(64),
    protectedResult: settingsEnvelope,
    ...(kind === "applied"
      ? {
          permissionPolicy: {
            effectiveId: command.input.intent.permissionTransition!.effectiveId,
            settingsVersion: { epoch: "native-epoch", revision },
          },
        }
      : {}),
  };
}
const record = (value: NativeSettingsEvidence) =>
  fixture.commands.recordSettingsEvidence(LOCAL_USER_ID, value);

describe("durable permission transitions", () => {
  it("keeps GUI/TUI requests pending without changing authority, rejects competitors, and commits only correlated native application", async () => {
    const before = await context();
    const selected = await admit(":danger-full-access", "gui");
    expect((await context()).permissionProfileId).toBe(
      before.permissionProfileId,
    );
    expect((await state()).pending[0]?.intent.permissionTransition).toEqual(
      selected.input.intent.permissionTransition,
    );
    const competing = await fixture.commands.admit(
      LOCAL_USER_ID,
      await input(":workspace"),
    );
    expect(competing.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "permission-transition-pending",
    });
    await dispatch(selected);
    await record(evidence(selected, "queued", "1"));
    expect((await context()).computerUseAuthorityGeneration).toBe(
      before.computerUseAuthorityGeneration,
    );
    expect((await state()).permissionPolicy).toBeNull();
    const applied = evidence(selected, "applied", "1");
    await record(applied);
    expect((await state()).permissionPolicy).toMatchObject({
      revision: "1",
      selectedId: ":danger-full-access",
      effectiveId: ":danger-full-access",
    });
    expect(effectivePermissionProfile(await context()).effectiveId).toBe(
      ":danger-full-access",
    );
    const confirmed = await state();
    await fixture.restart();
    await record(applied);
    expect(await state()).toEqual(confirmed);
    const rejected = await admit(":workspace");
    await dispatch(rejected);
    await record(evidence(rejected, "rejected", "2"));
    expect((await state()).desiredStatus).toBe("rejected");
    expect((await state()).permissionPolicy).toEqual(
      confirmed.permissionPolicy,
    );
  });

  it("pins a confirmed default and keeps requested/default/effective distinct under forced Primary policy", async () => {
    const selected = await admit(null);
    await dispatch(selected);
    await record(evidence(selected, "applied", "2"));
    const confirmed = (await state()).permissionPolicy!;
    const before = await context();
    await fixture.db
      .update(schema.userSettings)
      .set({ defaultPermissionProfileId: ":yolo" })
      .where(eq(schema.userSettings.userId, LOCAL_USER_ID));
    expect(effectivePermissionProfile(await context())).toMatchObject({
      selectedId: confirmed.resolvedSelectedId,
      effectiveId: confirmed.effectiveId,
      usesDefault: true,
      defaultId: ":yolo",
    });
    expect((await context()).computerUseAuthorityGeneration).toBe(
      before.computerUseAuthorityGeneration,
    );
    const forced = {
      ...(await context()),
      isPrimary: true,
      worktreePolicy: "required-for-writes" as const,
    };
    expect(resolvePermissionTransition(forced, null, "2")).toEqual({
      selectedId: null,
      resolvedSelectedId: ":yolo",
      effectiveId: ":read-only",
      expectedRevision: "2",
    });
    expect(effectivePermissionProfile(forced).effectiveId).toBe(":read-only");
  });

  it("resolves terminal choices from actual canonical source and rejects stale runtime/account identities", async () => {
    const request = await fixture.input();
    const resolved = await fixture.commands.resolvePermissionTransition(
      LOCAL_USER_ID,
      {
        workerId: fixture.workerId,
        session: request.session,
        selectedId: null,
      },
    );
    expect(resolved).toMatchObject({
      bindingId: (await state()).binding!.bindingId,
      permissionTransition: {
        selectedId: null,
        resolvedSelectedId: ":yolo",
        expectedRevision: "2",
      },
    });
    await expect(
      fixture.commands.resolvePermissionTransition(LOCAL_USER_ID, {
        workerId: fixture.workerId,
        session: { ...request.session, runtimeGeneration: "retired" },
        selectedId: ":yolo",
      }),
    ).rejects.toMatchObject({ code: "settings-binding-replaced" });
    await expect(
      fixture.commands.resolvePermissionTransition(LOCAL_USER_ID, {
        workerId: fixture.workerId,
        session: { ...request.session, providerAccountId: "other-account" },
        selectedId: ":yolo",
      }),
    ).rejects.toMatchObject({ code: "stale-session" });
    await expect(
      fixture.repository.setChatPermissionProfile(
        LOCAL_USER_ID,
        fixture.chatId,
        ":yolo",
      ),
    ).rejects.toMatchObject({ code: "permission-source-required" });
  });

  it("rechecks actual canonical policy at dispatch and does not apply a mismatched claim", async () => {
    const stale = await admit(null);
    await fixture.db
      .update(schema.userSettings)
      .set({ defaultPermissionProfileId: ":workspace" })
      .where(eq(schema.userSettings.userId, LOCAL_USER_ID));
    await expect(dispatch(stale)).rejects.toMatchObject({
      code: "permission-policy-replaced",
    });
    // Settle the not-dispatched command through its actual rejection path.
    await fixture.commands.settle(LOCAL_USER_ID, {
      workerId: fixture.workerId,
      operationId: stale.input.operationId,
      operationGeneration: stale.receipt.operationGeneration,
      status: "rejected",
      protectedResult: null,
      resultDigest: null,
      rejectionCode: "permission-policy-replaced",
      executionComplete: false,
    });
    const target = await admit(":yolo");
    await dispatch(target);
    const prior = (await state()).permissionPolicy;
    const wrong = evidence(target, "applied", "3");
    wrong.permissionPolicy!.effectiveId = ":workspace";
    expect((await record(wrong)).application.status).toBe("uncertain");
    expect((await state()).permissionPolicy).toEqual(prior);
    const later = await fixture.commands.admit(
      LOCAL_USER_ID,
      await input(":workspace"),
    );
    expect(later.receipt.rejectionCode).toBe("permission-transition-pending");
  });
  it("retains the durable resolved selection across cold resume while withholding current-runtime confirmation", async () => {
    const pinned = (await state()).permissionPolicy!;
    await fixture.db
      .update(schema.userSettings)
      .set({ defaultPermissionProfileId: ":yolo" })
      .where(eq(schema.userSettings.userId, LOCAL_USER_ID));
    await fixture.commands.refreshSettingsState(
      LOCAL_USER_ID,
      fixture.chatId,
      async (scope) => ({
        context: {
          chatId: scope.chatId,
          workerId: scope.workerId,
          threadId: scope.threadId,
          runtimeGeneration: "runtime-two",
          settingsVersion: { epoch: "resumed-core", revision: "0" },
        },
        protectedContent: settingsEnvelope,
        contentFingerprint: "d".repeat(64),
      }),
    );
    const resumed = await context();
    expect(resumed.nativePermissionPolicy).toEqual(pinned);
    expect(resumed.nativePermissionPolicyConfirmed).toBe(false);
    expect(effectivePermissionProfile(resumed)).toMatchObject({
      selectedId: pinned.resolvedSelectedId,
      effectiveId: pinned.effectiveId,
      defaultId: ":yolo",
    });
    const [original] = await fixture.db
      .select()
      .from(schema.nativeCommands)
      .where(eq(schema.nativeCommands.operationId, pinned.operationId));
    const recovery: NativeSettingsEvidence = {
      workerId: fixture.workerId,
      operationId: pinned.operationId,
      operationGeneration: pinned.operationGeneration,
      eventId: randomUUID(),
      threadId: pinned.source.threadId,
      runtimeGeneration: pinned.source.runtimeGeneration,
      nativeOperationId: original!.settingsApplication!.nativeOperationId,
      submissionId: original!.settingsApplication!.submissionId,
      kind: "applied",
      resultDigest: "f".repeat(64),
      protectedResult: settingsEnvelope,
      recoveryBindingId: (await state()).binding!.bindingId,
      permissionPolicy: {
        effectiveId: pinned.effectiveId,
        settingsVersion: { epoch: "resumed-core", revision: "0" },
      },
    };
    await expect(
      record({ ...recovery, recoveryBindingId: "retired-binding" }),
    ).rejects.toMatchObject({ code: "native-permission-recovery-binding" });
    expect(await record(recovery)).toMatchObject({
      application: { status: "applied" },
      permissionPolicyPublished: true,
    });
    expect((await state()).permissionPolicy).toMatchObject({
      revision: pinned.revision,
      operationId: pinned.operationId,
      source: { runtimeGeneration: "runtime-two" },
      settingsVersion: { epoch: "resumed-core", revision: "0" },
    });
    expect((await context()).nativePermissionPolicyConfirmed).toBe(true);
    await fixture.restart();
    expect(await record(recovery)).toMatchObject({
      permissionPolicyPublished: true,
    });
    expect((await state()).permissionPolicy?.revision).toBe(pinned.revision);
  });
});
