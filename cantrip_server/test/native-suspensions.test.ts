import { randomUUID } from "node:crypto";
import {
  nativeSuspensionRecordSchema,
  type NativeSuspensionActor,
  type NativeSuspensionEvidence,
} from "@cantrip/protocol";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { toContextualChatWireSummary } from "../src/db/repository/chat-mappers.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
const owner = LOCAL_USER_ID;
const active = { threadId: "native-thread", turnId: "original-turn" };
const actor = (): NativeSuspensionActor => ({
  workerGeneration: randomUUID(),
  runtimeGeneration: randomUUID(),
  operationId: randomUUID(),
  operationGeneration: randomUUID(),
});
const evidence = (revision = 1): NativeSuspensionEvidence => ({
  suspension: { ...active, checkpointId: `checkpoint-${revision}`, revision },
  storageId: randomUUID(),
  runtimeVersion: "test/cantrip-suspension-v8",
  runtimeFingerprint: "a".repeat(64),
});
const repo = () => fixture.repository.nativeSuspensions;
const state = () => repo().read(owner, fixture.chatId);
const row = async () =>
  (
    await fixture.db
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, fixture.chatId))
  )[0]!;
async function paused() {
  const request = await repo().request(owner, fixture.chatId, "pause");
  const a = actor();
  await repo().claim(
    owner,
    fixture.chatId,
    request.state.controlId,
    request.state.actor,
    a,
    active,
  );
  const checkpoint = evidence();
  const result = await repo().paused(
    owner,
    fixture.chatId,
    request.state.controlId,
    a,
    checkpoint,
  );
  return { ...result, actor: a, checkpoint, controlId: result.state.controlId };
}
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 120_000);
beforeEach(async () => {
  // Each case starts from the same empty state; close/reopen cases still use
  // the actual persistent database. Migrations need only run once per fixture.
  await fixture.client.exec(
    "DROP TRIGGER IF EXISTS fail_running ON chats; DROP FUNCTION IF EXISTS fail_running();",
  );
  await fixture.db.execute(
    sql`UPDATE chats SET native_suspension_state=NULL,automation_paused=false,managed_autonomy_stopped=false,placement_revision=1 WHERE id=${fixture.chatId}`,
  );
});
afterAll(async () => {
  await fixture?.close();
});

describe("durable native suspension repository (real migrated database)", () => {
  it("does not offer a previous running checkpoint after a new Pause fails", async () => {
    const p = await paused();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    await repo().claim(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    await repo().running(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
    );
    const pause = await repo().request(owner, fixture.chatId, "pause");
    await repo().failedControl(
      owner,
      fixture.chatId,
      pause.state.controlId,
      p.actor,
      { code: "pause-failed", protectedDetails: null },
    );
    expect((await state())?.checkpoint).toEqual(p.checkpoint);
    expect(
      toContextualChatWireSummary(await row()).nativeSuspension?.resumable,
    ).toBe(false);
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-not-resumable" });
    const retry = await repo().request(owner, fixture.chatId, "pause");
    await repo().claim(
      owner,
      fixture.chatId,
      retry.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    await repo().paused(
      owner,
      fixture.chatId,
      retry.state.controlId,
      p.actor,
      evidence(2),
    );
    expect(
      toContextualChatWireSummary(await row()).nativeSuspension?.resumable,
    ).toBe(true);
  });

  it("records a real pre-claim failure without inventing a resumable turn", async () => {
    const request = await repo().request(owner, fixture.chatId, "pause");
    await repo().failedControl(
      owner,
      fixture.chatId,
      request.state.controlId,
      null,
      { code: "worker-offline", protectedDetails: null },
    );
    expect(await state()).toMatchObject({
      phase: "error",
      checkpoint: null,
      actor: null,
    });
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-not-resumable" });
    expect(
      (await repo().request(owner, fixture.chatId, "pause")).state.phase,
    ).toBe("pausing");
  });

  it("retains Stop intent after a failed acknowledgement and permits only a Stop retry", async () => {
    const p = await paused();
    const stop = await repo().request(owner, fixture.chatId, "stop");
    await repo().failedControl(
      owner,
      fixture.chatId,
      stop.state.controlId,
      p.actor,
      { code: "stop-failed", protectedDetails: null },
    );
    await fixture.restart();
    expect(await state()).toMatchObject({
      phase: "error",
      action: "stop",
      checkpoint: p.checkpoint,
    });
    for (const action of ["pause", "resume"] as const)
      await expect(
        repo().request(owner, fixture.chatId, action),
      ).rejects.toMatchObject({ code: "suspension-stop-pending" });
    const retry = await repo().request(owner, fixture.chatId, "stop");
    await repo().claim(
      owner,
      fixture.chatId,
      retry.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    expect(
      (
        await repo().stopped(
          owner,
          fixture.chatId,
          retry.state.controlId,
          p.actor,
        )
      ).state,
    ).toMatchObject({ phase: "stopped", checkpoint: null });
  });

  it("keeps old chat JSON unchanged and separates intent from committed Pause", async () => {
    expect(toContextualChatWireSummary(await row())).not.toHaveProperty(
      "nativeSuspension",
    );
    const request = await repo().request(owner, fixture.chatId, "pause");
    expect(request.state).toMatchObject({
      phase: "pausing",
      checkpoint: null,
      active: null,
    });
    expect((await row()).automationPaused).toBe(true);
    const duplicate = await repo().request(owner, fixture.chatId, "pause");
    expect(duplicate).toEqual({ state: request.state, changed: false });
    expect(
      toContextualChatWireSummary(await row()).nativeSuspension?.phase,
    ).toBe("pausing");
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-not-resumable" });
  });

  it("retains committed identity and private source through database close/reopen", async () => {
    const p = await paused();
    await fixture.restart();
    expect(await state()).toEqual(p.state);
    expect((await row()).automationPaused).toBe(true);
    await expect(
      repo().failedControl(owner, fixture.chatId, p.controlId, p.actor, {
        code: "pause-failed",
        protectedDetails: null,
      }),
    ).rejects.toMatchObject({ code: "suspension-control-settled" });
    expect(await state()).toEqual(p.state);
    const summary = toContextualChatWireSummary(await row());
    expect(summary.nativeSuspension).toMatchObject({ phase: "paused", active });
    const publicJson = JSON.stringify(summary.nativeSuspension);
    for (const privateValue of [
      p.checkpoint.storageId,
      p.actor.operationId,
      p.actor.runtimeGeneration,
      p.state.target.placementId,
      p.checkpoint.runtimeFingerprint!,
    ])
      expect(publicJson).not.toContain(privateValue);
    expect(await repo().request(owner, fixture.chatId, "pause")).toEqual({
      state: p.state,
      changed: false,
    });
  });

  it("joins concurrent Resume, retains the hold, and fences the fresh owner", async () => {
    const p = await paused();
    const requests = await Promise.all([
      repo().request(owner, fixture.chatId, "resume"),
      repo().request(owner, fixture.chatId, "resume"),
    ]);
    expect(requests.filter((r) => r.changed)).toHaveLength(1);
    expect(requests[0]!.state.controlId).toBe(requests[1]!.state.controlId);
    const id = requests[0]!.state.controlId;
    expect((await row()).automationPaused).toBe(true);
    await expect(
      repo().running(owner, fixture.chatId, id, p.actor),
    ).rejects.toMatchObject({ code: "suspension-actor-unclaimed" });
    const fresh = actor();
    await repo().claim(owner, fixture.chatId, id, p.actor, fresh, active);
    await expect(
      repo().running(owner, fixture.chatId, id, p.actor),
    ).rejects.toMatchObject({ code: "suspension-actor-stale" });
    await expect(
      repo().finished(owner, fixture.chatId, id, p.actor, active, "completed"),
    ).rejects.toMatchObject({ code: "suspension-actor-stale" });
    await expect(
      repo().claim(owner, fixture.chatId, id, p.actor, actor(), active),
    ).rejects.toMatchObject({ code: "suspension-actor-stale" });
    expect(
      (await repo().running(owner, fixture.chatId, id, fresh)).state,
    ).toMatchObject({
      phase: "running",
      active,
      checkpoint: p.checkpoint,
      pausedAt: null,
    });
    expect((await row()).automationPaused).toBe(false);
    expect(
      (await repo().running(owner, fixture.chatId, id, fresh)).changed,
    ).toBe(false);
    await repo().finished(
      owner,
      fixture.chatId,
      id,
      fresh,
      active,
      "completed",
    );
    expect((await row()).automationPaused).toBe(false);
    expect(await state()).toMatchObject({
      phase: "completed",
      checkpoint: null,
    });
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-not-resumable" });
  });

  it("re-Pause supersedes an in-flight Resume and rejects its late acknowledgement", async () => {
    const p = await paused();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    const fresh = actor();
    await repo().claim(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
      fresh,
      active,
    );
    const pause = await repo().request(owner, fixture.chatId, "pause");
    await expect(
      repo().running(owner, fixture.chatId, resume.state.controlId, fresh),
    ).rejects.toMatchObject({ code: "suspension-control-stale" });
    expect((await row()).automationPaused).toBe(true);
    await repo().claim(
      owner,
      fixture.chatId,
      pause.state.controlId,
      fresh,
      fresh,
      active,
    );
    await repo().paused(
      owner,
      fixture.chatId,
      pause.state.controlId,
      fresh,
      evidence(2),
    );
    await fixture.restart();
    expect(await state()).toMatchObject({
      phase: "paused",
      active,
      checkpoint: { suspension: { revision: 2 } },
    });
  });

  it("Stop wins immediately, retains cleanup evidence until acknowledgement, and cannot resurrect", async () => {
    const p = await paused();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    const stop = await repo().request(owner, fixture.chatId, "stop");
    expect(stop.state).toMatchObject({
      phase: "stopping",
      checkpoint: p.checkpoint,
    });
    expect(await row()).toMatchObject({
      automationPaused: true,
      managedAutonomyStopped: true,
    });
    await expect(
      repo().running(owner, fixture.chatId, resume.state.controlId, p.actor),
    ).rejects.toMatchObject({ code: "suspension-control-stale" });
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-stop-pending" });
    await repo().claim(
      owner,
      fixture.chatId,
      stop.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    await repo().stopped(owner, fixture.chatId, stop.state.controlId, p.actor);
    await fixture.restart();
    expect(await state()).toMatchObject({ phase: "stopped", checkpoint: null });
    await expect(
      repo().paused(owner, fixture.chatId, p.controlId, p.actor, p.checkpoint),
    ).rejects.toMatchObject({ code: "suspension-control-stale" });
    await expect(
      repo().finished(
        owner,
        fixture.chatId,
        stop.state.controlId,
        p.actor,
        active,
        "completed",
      ),
    ).rejects.toMatchObject({ code: "suspension-control-settled" });
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-not-resumable" });
  });

  it("preserves evidence and encrypted error details through failed restoration", async () => {
    const p = await paused();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    const error = {
      code: "checkpoint-corrupt" as const,
      protectedDetails: settingsEnvelope,
    };
    await repo().failedControl(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
      error,
    );
    await fixture.restart();
    expect(await state()).toMatchObject({
      phase: "error",
      error,
      checkpoint: p.checkpoint,
    });
    await expect(
      repo().failedControl(
        owner,
        fixture.chatId,
        resume.state.controlId,
        p.actor,
        { ...error, message: "private native path or key" } as typeof error,
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(await row())).not.toContain(
      "private native path or key",
    );
    expect(
      (await repo().request(owner, fixture.chatId, "resume")).state.phase,
    ).toBe("resuming");
  });

  it("lets the actual database reject early unpause in every held phase", async () => {
    const p = await paused();
    const rejectUnpause = async () => {
      await expect(
        fixture.repository.setChatAutomationPaused(
          owner,
          fixture.chatId,
          false,
        ),
      ).rejects.toThrow();
      await expect(
        fixture.db.execute(
          sql`UPDATE chats SET automation_paused=false WHERE id=${fixture.chatId}`,
        ),
      ).rejects.toThrow();
      expect((await row()).automationPaused).toBe(true);
    };
    await rejectUnpause();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    await rejectUnpause();
    await repo().failedControl(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
      { code: "restore-failed", protectedDetails: null },
    );
    await rejectUnpause();
    await repo().request(owner, fixture.chatId, "stop");
    await rejectUnpause();
  });

  it("rolls back a real failed write and permits retry with the same committed evidence", async () => {
    const p = await paused();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    const claimed = await repo().claim(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    await fixture.client
      .exec(`CREATE FUNCTION fail_running() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.native_suspension_state->>'phase'='running' THEN RAISE EXCEPTION 'injected durable state write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_running BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION fail_running();`);
    await expect(
      repo().running(owner, fixture.chatId, resume.state.controlId, p.actor),
    ).rejects.toThrow();
    expect(await state()).toEqual(claimed.state);
    expect((await row()).automationPaused).toBe(true);
    await fixture.client.exec(
      "DROP TRIGGER fail_running ON chats; DROP FUNCTION fail_running();",
    );
    expect(
      (
        await repo().running(
          owner,
          fixture.chatId,
          resume.state.controlId,
          p.actor,
        )
      ).state.checkpoint,
    ).toEqual(p.checkpoint);
  });

  it("checks actual source at acknowledgement but keeps Stop available after placement changes", async () => {
    const p = await paused();
    const resume = await repo().request(owner, fixture.chatId, "resume");
    await repo().claim(
      owner,
      fixture.chatId,
      resume.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    await fixture.db.execute(
      sql`UPDATE chats SET placement_revision=placement_revision+1 WHERE id=${fixture.chatId}`,
    );
    await expect(
      repo().running(owner, fixture.chatId, resume.state.controlId, p.actor),
    ).rejects.toMatchObject({ code: "suspension-authority-changed" });
    expect((await row()).automationPaused).toBe(true);
    expect((await state())?.checkpoint).toEqual(p.checkpoint);
    const stop = await repo().request(owner, fixture.chatId, "stop");
    await repo().claim(
      owner,
      fixture.chatId,
      stop.state.controlId,
      p.actor,
      p.actor,
      active,
    );
    expect(
      (
        await repo().stopped(
          owner,
          fixture.chatId,
          stop.state.controlId,
          p.actor,
        )
      ).state.phase,
    ).toBe("stopped");
  });

  it("keeps unsupported bytes inspectable, held, and absent from public error messages", async () => {
    const raw = {
      version: 99,
      phase: "future-phase",
      secret: "not-for-public-status",
    };
    await fixture.db.execute(
      sql`UPDATE chats SET native_suspension_state=${JSON.stringify(raw)}::jsonb,automation_paused=true WHERE id=${fixture.chatId}`,
    );
    await fixture.restart();
    await expect(state()).rejects.toMatchObject({
      code: "suspension-state-unreadable",
      message: "suspension-state-unreadable",
    });
    await expect(
      repo().request(owner, fixture.chatId, "pause"),
    ).rejects.toMatchObject({ code: "suspension-state-unreadable" });
    const saved = await row();
    expect(saved.nativeSuspensionState).toEqual(raw);
    const summary = toContextualChatWireSummary(saved);
    expect(summary.nativeSuspension).toMatchObject({
      phase: "error",
      controlId: null,
      error: { code: "suspension-state-unreadable" },
    });
    expect(JSON.stringify(summary)).not.toContain(raw.secret);
    await expect(
      fixture.repository.setChatAutomationPaused(owner, fixture.chatId, false),
    ).rejects.toThrow();
  });

  it("does not grant durable resumability to an idle runtime or another owner", async () => {
    const request = await repo().request(owner, fixture.chatId, "pause");
    const a = actor();
    await repo().claim(
      owner,
      fixture.chatId,
      request.state.controlId,
      null,
      a,
      null,
    );
    const idle = await repo().idle(
      owner,
      fixture.chatId,
      request.state.controlId,
      a,
    );
    expect(idle.state).toMatchObject({
      phase: "idle",
      checkpoint: null,
      active: null,
    });
    expect((await row()).automationPaused).toBe(true);
    await expect(
      repo().request(owner, fixture.chatId, "resume"),
    ).rejects.toMatchObject({ code: "suspension-not-resumable" });
    await expect(
      repo().read("another-owner", fixture.chatId),
    ).rejects.toMatchObject({ code: "chat-not-found" });
    await expect(
      repo().request("another-owner", fixture.chatId, "stop"),
    ).rejects.toMatchObject({ code: "chat-not-found" });
  });

  it("rejects inconsistent checkpoints and authority-like fields before writing", async () => {
    const p = await paused();
    for (const invalid of [
      { ...p.state, active: { ...active, turnId: "replacement-turn" } },
      { ...p.state, phase: "completed" },
      { ...p.state, checkpoint: null },
      { ...p.state, actor: { ...p.actor, grant: "reusable-authority" } },
      {
        ...p.state,
        target: { ...p.state.target, path: "/private/provider/key" },
      },
      {
        ...p.state,
        checkpoint: {
          ...p.checkpoint,
          suspension: {
            ...p.checkpoint.suspension,
            revision: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      },
    ])
      expect(nativeSuspensionRecordSchema.safeParse(invalid).success).toBe(
        false,
      );
    expect(await state()).toEqual(p.state);
  });
});
