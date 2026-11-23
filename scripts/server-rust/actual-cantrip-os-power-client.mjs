import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eventually } from "./full-worker.mjs";

export async function actualCantripOsPowerClient({
  page,
  call,
  os,
  guest,
  record,
  instance,
  selected,
  result,
}) {
  const power = (method, ...args) =>
    call("api/cantrip-os-power", method, ...args);
  const readOperation = (instanceId, operationId) =>
    page.evaluate(
      async ({ instanceId, operationId }) => {
        const { requestResponse } = await import("/src/lib/api-client.ts");
        const response = await requestResponse(
          `/api/cantrip-os/${encodeURIComponent(instanceId)}/power-operations/${encodeURIComponent(operationId)}`,
          undefined,
          [409],
        );
        return { status: response.status, body: await response.json() };
      },
      { instanceId, operationId },
    );
  const files = [
    "/etc/cantrip-rust-server-proof",
    `${selected.homeGuestPath}/retained-proof.bin`,
  ];
  await guest.exec(
    "python3",
    "-c",
    "from pathlib import Path;import sys;[(Path(p).write_bytes('Private server lifecycle marker 🍄'.encode()+bytes([0,255])),Path(p).chmod(0o640)) for p in sys.argv[1:]]",
    ...files,
  );
  const fingerprints = async () =>
    JSON.parse(
      await guest.exec(
        "python3",
        "-c",
        "from pathlib import Path;import hashlib,json,stat,sys;print(json.dumps([{'sha256':hashlib.sha256(Path(p).read_bytes()).hexdigest(),'mode':stat.S_IMODE(Path(p).stat().st_mode),'uid':Path(p).stat().st_uid,'gid':Path(p).stat().st_gid} for p in sys.argv[1:]]))",
        ...files,
      ),
    );
  const before = await fingerprints();
  const transition = async (action, { loseReply = false } = {}) => {
    const status = record(
      `power-before-${action}`,
      await power("getCantripOsPower", instance),
    );
    assert.ok(status.target, JSON.stringify(status));
    const draft = await call(
      "cantrip-os-power-draft",
      "prepareCantripOsPowerDraft",
      status.target,
      action,
    );
    draft.submitted = true;
    await call("cantrip-os-power-draft", "saveCantripOsPowerDraft", draft);
    let completed;
    const route = /\/api\/cantrip-os\/[^/]+\/power-operations$/;
    if (loseReply) {
      await page.route(route, async (request) => {
        const response = await request.fetch();
        assert.equal(response.status(), 200);
        completed = await response.json();
        await request.abort("failed");
      });
      try {
        await assert.rejects(power("submitCantripOsPower", draft));
      } finally {
        await page.unroute(route);
      }
    } else completed = await power("submitCantripOsPower", draft);
    record(`power-${action}${loseReply ? "-lost-reply" : ""}`, completed);
    assert.equal(completed.state, "ready", JSON.stringify(completed));
    const actual = (await guest.json("inspect", guest.id))[0];
    assert.equal(actual.State.Running, action !== "stop");
    const replay = record(
      `power-${action}-replayed`,
      await power("submitCantripOsPower", draft),
    );
    assert.equal(replay.operationId, completed.operationId);
    assert.equal(replay.state, "ready");
    const after = (await guest.json("inspect", guest.id))[0];
    assert.equal(after.Id, actual.Id);
    assert.equal(after.State.StartedAt, actual.State.StartedAt);
    assert.equal(after.State.FinishedAt, actual.State.FinishedAt);
    const saved = await call(
      "cantrip-os-power-draft",
      "readCantripOsPowerDraft",
      instance.id,
    );
    assert.deepEqual(saved, draft);
    const observed = record(
      `power-${action}-observed`,
      await power("observeCantripOsPowerDraft", saved),
    );
    const read = record(
      `power-${action}-read`,
      await readOperation(instance.id, completed.operationId),
    );
    assert.deepEqual(read, { status: 200, body: observed });
    const afterRead = (await guest.json("inspect", guest.id))[0];
    assert.equal(afterRead.Id, after.Id);
    assert.equal(afterRead.State.StartedAt, after.State.StartedAt);
    assert.equal(afterRead.State.FinishedAt, after.State.FinishedAt);
    return completed;
  };
  const stopped = await transition("stop");
  await transition("start");
  await eventually(
    async () => {
      try {
        return {
          value: await os("inspectCantripOs", {
            workerId: instance.workerId,
            transport: { kind: "docker", container: guest.name },
          }),
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    (value) => assert.ok(value.value, value.error),
  );
  const recovered = record(
    "power-start-recovery",
    await os("recoverCantripOsInstance", instance),
  );
  assert.equal(recovered.recovery.kind, "runtime-changed");
  assert.equal(recovered.instance.guestInstanceId, instance.guestInstanceId);
  assert.notEqual(
    recovered.instance.runtimeGeneration,
    instance.runtimeGeneration,
  );
  instance = recovered.instance;
  assert.deepEqual(await fingerprints(), before);
  await transition("restart", { loseReply: true });
  await eventually(
    async () => {
      try {
        return {
          value: await os("inspectCantripOs", {
            workerId: instance.workerId,
            transport: { kind: "docker", container: guest.name },
          }),
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    (value) => assert.ok(value.value, value.error),
  );
  const restarted = record(
    "power-restart-recovery",
    await os("recoverCantripOsInstance", instance),
  );
  assert.equal(restarted.recovery.kind, "runtime-changed");
  instance = restarted.instance;
  assert.deepEqual(await fingerprints(), before);
  const history = record(
    "power-history",
    await power("getCantripOsPowerOperations", instance.id),
  );
  assert.equal(
    history.items.find((row) => row.operationId === stopped.operationId).state,
    "ready",
  );
  assert.equal((await guest.json("inspect", guest.id))[0].State.Running, true);
  assert.deepEqual(
    record(
      "power-read-missing",
      await readOperation(instance.id, randomUUID()),
    ),
    { status: 409, body: { error: "Power operation not found." } },
  );
  record("power-retained-files", before);
  result.steps.push(
    "retained Docker stop/start/restart preserve root and workspace bytes/modes/ownership; lost HTTP acknowledgment and saved-request replay cannot repeat a power effect, and explicit recovery observes a new runtime; retained operation GETs return the saved receipts and the missing-operation conflict without changing Docker state",
  );
  return instance;
}
