import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type {
  NativeCommandAdmission,
  NativeCommandReceipt,
  NativeSettingsEvidence,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});
const state = () =>
  fixture.commands.settingsState(LOCAL_USER_ID, fixture.chatId);
async function admit(origin: "gui" | "terminal" = "terminal") {
  const input = await fixture.input(origin);
  const { receipt } = await fixture.commands.admit(LOCAL_USER_ID, input);
  expect(receipt.status).toBe("accepted");
  return { input, receipt };
}
async function dispatch(command: {
  input: NativeCommandAdmission;
  receipt: NativeCommandReceipt;
}) {
  await fixture.commands.dispatch(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    operationId: command.input.operationId,
    operationGeneration: command.receipt.operationGeneration,
    payloadDigest: command.input.payloadDigest,
    session: command.input.session,
  });
}
function event(
  command: { input: NativeCommandAdmission; receipt: NativeCommandReceipt },
  kind: NativeSettingsEvidence["kind"],
): NativeSettingsEvidence {
  return {
    workerId: fixture.workerId,
    operationId: command.input.operationId,
    operationGeneration: command.receipt.operationGeneration,
    nativeOperationId: command.input.intent.nativeSettingsOperationId!,
    threadId: command.input.session.threadId!,
    runtimeGeneration: command.input.session.runtimeGeneration!,
    eventId: randomUUID(),
    kind,
    submissionId: kind === "transport-lost" ? null : command.input.operationId,
    resultDigest: "b".repeat(64),
    protectedResult: settingsEnvelope,
  };
}
const record = (evidence: NativeSettingsEvidence) =>
  fixture.commands.recordSettingsEvidence(LOCAL_USER_ID, evidence);
async function settle(
  command: { input: NativeCommandAdmission; receipt: NativeCommandReceipt },
  status: "applied" | "rejected" | "uncertain",
) {
  return fixture.commands.settle(LOCAL_USER_ID, {
    workerId: fixture.workerId,
    operationId: command.input.operationId,
    operationGeneration: command.receipt.operationGeneration,
    status,
    protectedResult: null,
    resultDigest: null,
    rejectionCode: null,
    executionComplete: false,
  });
}

describe("durable shared native settings", () => {
  it("records both origins, separates RPC success from application and survives restart/replay", async () => {
    const first = await admit("terminal");
    const accepted = await state();
    expect(accepted).toMatchObject({
      desiredStatus: "accepted",
      effective: null,
      desired: {
        operationId: first.input.operationId,
        origin: "terminal",
        protectedContent: settingsEnvelope,
      },
    });
    await dispatch(first);
    await settle(first, "applied");
    expect((await state())?.desiredStatus).toBe("dispatched");
    await record(event(first, "applied"));
    expect((await state())?.desiredStatus).toBe("applied");
    const second = await admit("gui");
    await dispatch(second);
    await record(event(second, "rejected"));
    const stored = await state();
    expect(stored).toMatchObject({
      desiredStatus: "rejected",
      effective: null,
      desired: { operationId: second.input.operationId, origin: "gui" },
      pending: [],
    });
    await fixture.restart();
    expect(await state()).toEqual(stored);
    expect(
      (await fixture.commands.admit(LOCAL_USER_ID, first.input)).replayed,
    ).toBe(true);
    expect(await state()).toEqual(stored); // Old terminal operations cannot become desired again.
    expect(
      await fixture.commands.settingsState("another-owner", fixture.chatId),
    ).toBeNull();
  });

  it("settles old requests independently while concurrent evidence is replayed", async () => {
    const first = await admit();
    const second = await admit("gui");
    await dispatch(first);
    await dispatch(second);
    const applied = event(first, "applied");
    await Promise.all([
      record(applied),
      record(applied),
      record(event(first, "queued")),
    ]);
    const pending = await state();
    expect(pending?.desired?.operationId).toBe(second.input.operationId);
    expect(pending?.desiredStatus).toBe("dispatched");
    expect(pending?.pending.map((entry) => entry.intent.operationId)).toEqual([
      second.input.operationId,
    ]);
    await record(applied);
    expect(await state()).toEqual(pending);
    await record(event(second, "applied"));
    const completed = await state();
    await settle(second, "uncertain"); // Late transport failure cannot undo confirmed application.
    expect(await state()).toEqual(completed);
    await record(event(second, "rejected"));
    expect((await state())?.desiredStatus).toBe("uncertain");
    const conflict = await state();
    await record(event(second, "queued"));
    expect(await state()).toEqual(conflict);
  });

  it("rejects pre-dispatch requests without changing effective settings and excludes failed admission", async () => {
    const command = await admit();
    await settle(command, "rejected");
    expect((await state())?.desiredStatus).toBe("rejected");
    const stored = await state();
    const invalid = await fixture.input();
    invalid.session.threadId = "wrong-thread";
    expect(
      (await fixture.commands.admit(LOCAL_USER_ID, invalid)).receipt.status,
    ).toBe("rejected");
    expect(await state()).toEqual(stored);
  });

  it("rolls command admission and evidence back when canonical settings persistence fails", async () => {
    await fixture.client.exec(`
      CREATE FUNCTION fail_settings_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected settings persistence failure'; END $$;
      CREATE TRIGGER fail_settings_write BEFORE INSERT OR UPDATE ON native_settings_states
        FOR EACH ROW EXECUTE FUNCTION fail_settings_write();
    `);
    const input = await fixture.input();
    const prior = await state();
    try {
      await expect(
        fixture.commands.admit(LOCAL_USER_ID, input),
      ).rejects.toThrow();
      expect(
        await fixture.commands.lookup(
          LOCAL_USER_ID,
          fixture.workerId,
          input.operationId,
        ),
      ).toBeNull();
      expect(await state()).toEqual(prior);
    } finally {
      await fixture.client.exec(
        "DROP TRIGGER fail_settings_write ON native_settings_states",
      );
    }
    const { receipt } = await fixture.commands.admit(LOCAL_USER_ID, input);
    const command = { input, receipt };
    await dispatch(command);
    const evidence = event(command, "applied");
    const dispatched = await state();
    await fixture.client
      .exec(`CREATE TRIGGER fail_settings_write BEFORE INSERT OR UPDATE ON native_settings_states
      FOR EACH ROW EXECUTE FUNCTION fail_settings_write()`);
    try {
      await expect(record(evidence)).rejects.toThrow();
      expect(
        (
          await fixture.commands.lookup(
            LOCAL_USER_ID,
            fixture.workerId,
            input.operationId,
          )
        )?.settingsApplication,
      ).toMatchObject({ status: "pending", evidenceCount: 0 });
      expect(await state()).toEqual(dispatched);
    } finally {
      await fixture.client.exec(
        "DROP TRIGGER fail_settings_write ON native_settings_states",
      );
    }
    expect((await record(evidence)).application).toMatchObject({
      status: "applied",
      evidenceCount: 1,
    });
    expect((await state())?.desiredStatus).toBe("applied");
  });

  it("serializes simultaneous GUI and terminal intents without lost updates", async () => {
    const prior = await state();
    const inputs = await Promise.all([
      fixture.input("gui"),
      fixture.input("terminal"),
    ]);
    const results = await Promise.all(
      inputs.map((input) => fixture.commands.admit(LOCAL_USER_ID, input)),
    );
    expect(results.map((result) => result.receipt.status)).toEqual([
      "accepted",
      "accepted",
    ]);
    const updated = await state();
    expect(BigInt(updated!.desiredRevision)).toBe(
      BigInt(prior!.desiredRevision) + 2n,
    );
    expect(
      new Set(updated!.pending.map((entry) => entry.intent.operationId)),
    ).toEqual(new Set(inputs.map((input) => input.operationId)));
    expect(updated!.pending.map((entry) => entry.desiredRevision)).toEqual([
      (BigInt(prior!.desiredRevision) + 1n).toString(),
      updated!.desiredRevision,
    ]);
  });
});
