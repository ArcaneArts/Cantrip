import assert from "node:assert/strict";
import path from "node:path";
import { cp } from "node:fs/promises";
import { eventually } from "./full-worker.mjs";
import { CantripOsProductFixture } from "./cantrip-os-product-fixture.mjs";
import { actualCantripOsPowerClient } from "./actual-cantrip-os-power-client.mjs";
import { actualCantripOsPackageClient } from "./actual-cantrip-os-package-client.mjs";

export async function actualCantripOsClient({
  page,
  fixture,
  root,
  dataDirectory,
  workerId,
  startWorker,
  stopWorker,
  result,
}) {
  const guest = new CantripOsProductFixture(
    path.join(root, fixture.kind, "os-guest"),
  );
  const report = (result.cantripOs = {
    snapshots: [],
    guestDirectory: guest.directory,
  });
  const ids = new Map();
  const normalize = (value, key = "") => {
    if (typeof value === "string") {
      if (key === "nonce") {
        assert.equal(Buffer.from(value, "base64").length, 12);
        return "<validated nonce>";
      }
      if (key === "ciphertext") {
        assert.ok(Buffer.from(value, "base64").length >= 16);
        return "<authenticated opaque outcome>";
      }
      if (key.endsWith("At")) {
        assert.ok(Number.isFinite(Date.parse(value)), key);
        return "<checked timestamp>";
      }
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
        if (!ids.has(value)) ids.set(value, `identity:${ids.size}`);
        return ids.get(value);
      }
      return value === guest.name ? "<owned-container>" : value;
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((field) => [field, normalize(value[field], field)]),
      );
    return value;
  };
  const record = (label, value) => {
    report.snapshots.push({ label, value: normalize(value) });
    console.error("Actual CantripOS:", label);
    return value;
  };
  const call = (module, method, ...args) =>
    page.evaluate(
      async ({ module, method, args }) => {
        const api = await import(`/src/lib/${module}.ts`);
        return api[method](...args);
      },
      { module, method, args },
    );
  const os = (method, ...args) => call("api/cantrip-os", method, ...args);
  const desktop = (method, ...args) =>
    call("api/cantrip-os-desktop", method, ...args);
  const workspace = (method, ...args) =>
    call("api/cantrip-os-workspace-operations", method, ...args);
  let succeeded = false;
  try {
    // Populate the ordinary Worker-owned public artifact catalog. The full
    // worker reads and snapshots these files through its production catalog.
    await cp(
      process.env.CANTRIP_TEST_OS_PACKAGE_DIRECTORY,
      path.join(dataDirectory, "cantrip-os-packages"),
      { recursive: true },
    );
    await guest.start();
    report.containerId = guest.id;
    report.containerName = guest.name;
    report.volumes = guest.volumes;
    report.imageId = guest.image.Id;
    const transport = { kind: "docker", container: guest.name };
    // Docker start acknowledges before its optional guest services finish
    // starting. Retry only this actual read through the production worker.
    report.bootObservations = [];
    const inspection = await eventually(
      async () => {
        try {
          return {
            value: await os("inspectCantripOs", { workerId, transport }),
          };
        } catch (error) {
          report.bootObservations.push(error.message);
          return { error: error.message };
        }
      },
      (value) => assert.ok(value.value, value.error),
    );
    const inspected = inspection.value;
    assert.equal(inspected.attachment, null);
    const attached = record(
      "attached",
      await os("attachCantripOs", {
        workerId,
        transport,
        guestInstanceId: inspected.guestInstanceId,
        name: "Owned Rust server CantripOS",
        expectedAttachmentGeneration: null,
      }),
    );
    let instance = attached.instance;
    assert.equal(instance.status, "connected");
    assert.equal(instance.guestInstanceId, inspected.guestInstanceId);
    const draft = await call(
      "cantrip-os-workspace-create-draft",
      "prepareCantripOsWorkspaceCreateDraft",
      instance,
      "work",
    );
    draft.submitted = true;
    await call(
      "cantrip-os-workspace-create-draft",
      "saveCantripOsWorkspaceCreateDraft",
      draft,
    );
    const workerBefore = (await call("api/worker-wire", "getWorkers")).find(
      (item) => item.workerId === workerId,
    );
    let originalReceipt;
    const creationRoute = /\/api\/cantrip-os\/[^/]+\/workspaces$/;
    await page.route(creationRoute, async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      originalReceipt = await response.json();
      assert.equal(originalReceipt.state, "ready");
      // The actual Server has committed its receipt. Lose that HTTP reply and
      // kill its process while the original full Worker stays running.
      report.workspaceCrash = fixture.workerFixture
        ? await fixture.replacePeer(0, fixture.peers[0].kind, { crash: true })
        : await fixture.restart({ crash: true });
      await route.abort("failed");
    });
    try {
      await assert.rejects(workspace("submitCantripOsWorkspaceCreate", draft));
    } finally {
      await page.unroute(creationRoute);
    }
    await eventually(
      () => call("api/worker-wire", "getWorkers"),
      (workers) => {
        const current = workers.find((item) => item.workerId === workerId);
        assert.equal(current?.online, true);
        assert.equal(current.startedAt, workerBefore.startedAt);
      },
    );
    const created = record(
      "workspace-created",
      await workspace("observeCantripOsWorkspaceCreateDraft", draft),
    );
    assert.equal(created.state, "ready");
    assert.deepEqual(created.result, originalReceipt);
    result.steps.push(
      "actual Server SIGKILL after workspace receipt commit and lost browser acknowledgment recover the original admission with the same full Worker process",
    );
    const repeated = record(
      "workspace-replayed",
      await workspace("submitCantripOsWorkspaceCreate", draft),
    );
    assert.deepEqual(repeated.result, created.result);
    const workspaces = await os("getCantripOsWorkspaces", instance.id);
    const selected = workspaces.find(
      (item) => item.guestWorkspaceId === "work",
    );
    assert.ok(selected);
    assert.equal(
      workspaces.filter((item) => item.guestWorkspaceId === "work").length,
      1,
    );
    report.workspaceId = selected.id;
    record(
      "workspace-history",
      await workspace(
        "getCantripOsWorkspaceOperations",
        instance.id,
        undefined,
        draft.accountKey,
      ),
    );
    result.steps.push(
      "actual Docker guest attachment and retained workspace-create admission use the existing browser SDK and full worker without duplicate creation",
    );

    const desktopOperations = [];
    for (const action of ["start", "restart", "stop"]) {
      const status = record(
        `desktop-before-${action}`,
        await desktop("getCantripOsDesktop", instance, selected),
      );
      assert.ok(status.target, JSON.stringify(status));
      const intent = await call(
        "cantrip-os-desktop-draft",
        "prepareCantripOsDesktopDraft",
        status.target,
        action,
      );
      intent.submitted = true;
      await call(
        "cantrip-os-desktop-draft",
        "saveCantripOsDesktopDraft",
        intent,
      );
      const completed = record(
        `desktop-${action}`,
        await desktop("submitCantripOsDesktop", intent),
      );
      assert.equal(completed.state, "ready", JSON.stringify(completed));
      desktopOperations.push(completed);
      const actual = await guest.target();
      assert.equal(actual.status, action === "stop" ? "stopped" : "running");
      const replay = record(
        `desktop-${action}-replayed`,
        await desktop("submitCantripOsDesktop", intent),
      );
      assert.equal(replay.operationId, completed.operationId);
      assert.equal(replay.completionEvidence, completed.completionEvidence);
      assert.deepEqual(
        await guest.target(),
        actual,
        "repeated create cannot repeat a desktop transition",
      );
    }
    record(
      "desktop-history",
      await desktop("getCantripOsDesktopOperations", instance.id, selected.id),
    );
    assert.equal(
      (await os("getCantripOsInstances")).find(
        (item) => item.id === instance.id,
      ).runtimeGeneration,
      instance.runtimeGeneration,
    );
    result.steps.push(
      "workspace desktop start/restart/stop retain immutable admissions and exact guest targets on replay without changing the executor runtime",
    );

    instance = await actualCantripOsPowerClient({
      page,
      call,
      os,
      guest,
      record,
      instance,
      selected,
      result,
    });
    const installed = await actualCantripOsPackageClient({
      page,
      call,
      os,
      guest,
      record,
      instance,
      result,
      report,
    });
    instance = installed.instance;
    await stopWorker();
    await fixture.restart();
    await startWorker();
    await eventually(
      () => call("api/worker-wire", "getWorkers"),
      (workers) =>
        assert.equal(
          workers.find((item) => item.workerId === workerId)?.online,
          true,
        ),
    );
    const retained = record(
      "retained-instance",
      (await os("getCantripOsInstances")).find(
        (item) => item.id === instance.id,
      ),
    );
    assert.equal(retained.id, instance.id);
    assert.equal(retained.attachmentGeneration, instance.attachmentGeneration);
    assert.equal(retained.runtimeGeneration, instance.runtimeGeneration);
    const history = record(
      "retained-desktop-history",
      await desktop("getCantripOsDesktopOperations", instance.id, selected.id),
    );
    for (const item of desktopOperations)
      assert.deepEqual(
        history.items.find((row) => row.operationId === item.operationId),
        item,
      );
    const observed = record(
      "workspace-observed-after-restart",
      await workspace("observeCantripOsWorkspaceCreateDraft", draft),
    );
    assert.deepEqual(observed.result, created.result);
    const packageHistory = record(
      "retained-package-history",
      await call(
        "api/cantrip-os-packages",
        "getCantripOsPackageOperations",
        instance.id,
      ),
    );
    for (const original of installed.summaries) {
      const retained = packageHistory.items.find(
        (row) => row.operationId === original.operationId,
      );
      assert.deepEqual(retained, original);
      const opened = await call(
        "cantrip-os-package-encryption",
        "openCantripOsPackageResult",
        retained,
      );
      assert.equal(opened.record.state, "ready");
    }
    result.steps.push(
      "actual production server and full-worker restart preserve CantripOS attachment/runtime identity and exact workspace/desktop history",
    );
    report.summary = report.snapshots;
    succeeded = true;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await guest.close({ preserve: !succeeded });
    report.guestPreserved = !succeeded;
  }
}
