import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeSettingsObservationRequestSchema,
  nativeSettingsRefreshRequestSchema,
  nativeSettingsStateSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openNativeSettingsSnapshot,
  protectNativeSettingsSnapshot,
} from "../../cantrip_worker/src/native-settings-content.ts";

export function settingsSnapshotPeer({ ensure, available, oracle, scope }) {
  const ready = Promise.withResolvers();
  const published = Promise.withResolvers();
  let effective;
  let binding;
  let lost;
  const requestRead = (fields = {}) =>
    ensure({ type: "chat.settings.read", scope: { ...scope, ...fields } });
  async function verify(snapshot) {
    const { context } = snapshot;
    assert.equal(context.threadId, scope.threadId);
    assert.equal(context.chatId, scope.chatId);
    assert.equal(context.workerId, scope.workerId);
    const args = { context, service: oracle };
    const settings = await openNativeSettingsSnapshot({ ...args, snapshot });
    const reference = await protectNativeSettingsSnapshot({
      ...args,
      settings,
      modelAttribution: snapshot.modelAttribution.selection,
    });
    assert.equal(snapshot.contentFingerprint, reference.contentFingerprint);
    assert.equal(
      snapshot.modelAttribution.fingerprint,
      reference.modelAttribution.fingerprint,
    );
    assert.ok(!JSON.stringify(snapshot).includes(settings.cwd));
    return settings;
  }
  return {
    async apply(action, body, send, drop) {
      if (action === "settings-refresh") {
        assert.deepEqual(nativeSettingsRefreshRequestSchema.parse(body), {
          workerId: scope.workerId,
          chatId: scope.chatId,
        });
        const reply = await requestRead();
        assert.equal(reply.ok, true, JSON.stringify(reply));
        await verify(reply.result);
        effective = reply.result;
        binding ??= {
          ...scope,
          bindingId: randomUUID(),
          runtimeGeneration: effective.context.runtimeGeneration,
          nativeEpoch: effective.context.settingsVersion.epoch,
        };
        send(
          nativeSettingsStateSchema.parse({
            chatId: scope.chatId,
            revision: "0",
            desiredRevision: "0",
            desired: null,
            desiredStatus: null,
            pending: [],
            binding,
            effective,
          }),
        );
        ready.resolve();
        return;
      }
      const { bindingId, snapshot } =
        nativeSettingsObservationRequestSchema.parse(body);
      assert.equal(bindingId, binding.bindingId);
      const settings = await verify(snapshot);
      assert.ok(
        BigInt(settings.settingsVersion.revision) >
          BigInt(effective.context.settingsVersion.revision),
      );
      if (!lost) {
        lost = snapshot;
        drop();
        return;
      }
      // Newer changes may supersede an older undelivered snapshot. If the
      // worker repeats a version, it uses the same sealed envelope.
      if (
        lost.context.settingsVersion.revision ===
        snapshot.context.settingsVersion.revision
      )
        assert.deepEqual(snapshot, lost);
      effective = snapshot;
      send({
        bindingId,
        revision: settings.settingsVersion.revision,
        settingsVersion: settings.settingsVersion,
      });
      if (settings.effort === null && settings.serviceTier === null)
        published.resolve();
    },
    async verifyReadScope() {
      await available(ready.promise);
      assert.equal((await requestRead({ workerId: "wrong-worker" })).ok, false);
      assert.equal(
        (await requestRead({ placementId: "wrong-placement" })).ok,
        false,
      );
      const sameSource = await requestRead({ modelRouteId: "previous-route" });
      assert.equal(sameSource.ok, true, JSON.stringify(sameSource));
      await verify(sameSource.result);
    },
    async verifyUpdates() {
      await available(published.promise);
      console.log(
        "Protected settings observations matched the Node codec and recovered a dropped publication.",
      );
    },
  };
}
