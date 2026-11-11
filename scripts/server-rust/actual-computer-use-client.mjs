// Existing browser encryption/client and full worker/native capability discovery.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function prepareActualComputerUse({
  page,
  projectId,
  workerId,
  result,
  fakeCapture = false,
}) {
  const title = "Private computer-use Chat " + crypto.randomUUID();
  const chat = await page.evaluate(
    async ({ projectId, workerId, title }) => {
      const api = await import("/src/lib/api/chats.ts");
      await (
        await import("/src/lib/api/settings.ts")
      ).updateSettings({ computerUseEnabled: true });
      const created = await api.createChat(
        projectId,
        title,
        undefined,
        undefined,
        undefined,
        { kind: "worker", projectId, workerId },
      );
      await api.updateChatPermissionProfile(created.id, ":workspace");
      return created;
    },
    { projectId, workerId, title },
  );
  assert.equal(chat.title, title);
  result.steps.push(
    "existing browser API creates an encrypted computer-use Chat with an explicit approval profile",
  );
  const prepared = { id: chat.id, title, workerId, fakeCapture };
  await actualComputerUse({
    page,
    prepared,
    result,
    phase: "connected",
    approvals: false,
  });
  return prepared;
}

async function actualEffects(page, workerId, testUnsupported) {
  const observed = await page.evaluate(
    async ({ workerId, testUnsupported }) => {
      const { requestResponse } = await import("/src/lib/api-client.ts");
      const { getSettings, updateSettings } =
        await import("/src/lib/api/settings.ts");
      const read = async () => {
        const response = await requestResponse(
          `/api/settings/computer-use/workers/${encodeURIComponent(workerId)}/effects`,
        );
        return {
          cacheControl: response.headers.get("cache-control"),
          status: await response.json(),
        };
      };
      const original = (await getSettings()).preferences;
      const initial = await read();
      if (!testUnsupported)
        return {
          initial,
          initialRevision: original.computerUseEffectsRevision,
        };
      const enabled = (
        await updateSettings({
          computerUseEffects: {
            effect: "cursor-warp",
            parameters: { strength: 0.5 },
          },
        })
      ).preferences;
      const unsupported = await read();
      const disabled = (
        await updateSettings({
          computerUseEffects: { effect: "off", parameters: {} },
        })
      ).preferences;
      return {
        initial,
        initialRevision: original.computerUseEffectsRevision,
        unsupported,
        enabledRevision: enabled.computerUseEffectsRevision,
        restored: await read(),
        disabledRevision: disabled.computerUseEffectsRevision,
      };
    },
    { workerId, testUnsupported },
  );
  const off = { effect: "off", parameters: {} };
  const assertOff = (effect, revision) => {
    assert.equal(effect.cacheControl, "no-store");
    assert.equal(effect.status.revision, revision ?? 1);
    assert.equal(effect.status.state, "running");
    assert.equal(effect.status.error, null);
    assert.deepEqual(effect.status.configuration, off);
    assert.deepEqual(effect.status.native.configuration, off);
  };
  assertOff(observed.initial, observed.initialRevision);
  if (testUnsupported) {
    const failure = observed.unsupported.status;
    assert.equal(observed.unsupported.cacheControl, "no-store");
    assert.ok(observed.enabledRevision > (observed.initialRevision ?? 1));
    assert.ok(observed.disabledRevision > observed.enabledRevision);
    assert.equal(failure.revision, observed.enabledRevision);
    assert.equal(failure.state, "failed");
    assert.match(failure.error, /^The target or action is unsupported\./u);
    assert.deepEqual(failure.configuration, {
      effect: "cursor-warp",
      parameters: { strength: 0.5 },
    });
    assertOff(observed.restored, observed.disabledRevision);
  }
  return observed;
}

async function actualFakeCapture(page) {
  const observed = await page.evaluate(async () => {
    const { client, lease, chatId } = window.actualComputerUse;
    const chats = await import("/src/lib/api/chats.ts");
    const { request } = await import("/src/lib/api-client.ts");
    const approvals = [];
    const approved = async (action) => {
      const blocked = await client.operation(lease, action);
      if (
        blocked.content.status !== "error" ||
        blocked.content.code !== "approval-required" ||
        blocked.bytes
      )
        throw new Error(
          `Expected approval for ${action.operation}: ${JSON.stringify(blocked.content)}`,
        );
      const rows = await chats.getAgentInteractionRequests({
        chatId,
        status: "pending",
      });
      const [pending] = rows;
      if (rows.length !== 1 || pending.payload.kind !== "permissions")
        throw new Error(
          `Expected one protected permission for ${action.operation}`,
        );
      const wire = await request(`/api/agent-requests/${pending.id}`);
      if ("payload" in wire || !wire.protectedPayload?.envelope?.ciphertext)
        throw new Error("The server exposed the approval content");
      const resolved = await chats.respondToAgentInteractionRequest(
        pending.id,
        {
          idempotencyKey: crypto.randomUUID(),
          response: {
            kind: "permissions",
            permissions: pending.payload.requestedPermissions,
            scope: "session",
            strictAutoReview: false,
          },
        },
      );
      if (resolved.status !== "resolved")
        throw new Error(`Approval did not resolve for ${action.operation}`);
      approvals.push({ id: pending.id, operation: action.operation });
      const result = await client.operation(lease, action);
      if (result.content.status !== "ok")
        throw new Error(JSON.stringify(result.content));
      return result;
    };
    const listed = await approved({ operation: "targets.list" });
    const monitor = listed.content.data.targets.find(
      ({ id }) => id === "fake-monitor",
    );
    if (!monitor) throw new Error("The disposable fake monitor is unavailable");
    const target = {
      targetId: monitor.id,
      targetGeneration: monitor.generation,
    };
    const opened = await approved({ operation: "session.open", ...target });
    const binding = opened.content.data.session.binding;
    const snapshot = await approved({
      operation: "observation.snapshot",
      sessionId: binding.sessionId,
      ...target,
    });
    if (!snapshot.bytes)
      throw new Error("The encrypted snapshot had no pixels");
    try {
      const png = await createImageBitmap(
        new Blob([snapshot.bytes], { type: "image/png" }),
      );
      try {
        return {
          approvals,
          binding,
          image: snapshot.content.data.image,
          decodedSize: [png.width, png.height],
          byteLength: snapshot.bytes.byteLength,
        };
      } finally {
        png.close();
      }
    } finally {
      snapshot.bytes.fill(0);
    }
  });
  assert.deepEqual(
    observed.approvals.map(({ operation }) => operation),
    ["targets.list", "session.open", "observation.snapshot"],
  );
  assert.equal(observed.binding.threadId, null);
  assert.equal(observed.binding.turnId, null);
  assert.equal(observed.image.mediaType, "image/png");
  assert.deepEqual(observed.decodedSize, [640, 360]);
  assert.ok(observed.byteLength > 0);
  return observed;
}

export async function actualComputerUse({
  page,
  prepared,
  result,
  phase,
  approvals = true,
}) {
  const packets = [],
    stops = [],
    pendingResponses = [];
  const response = (value) => {
    if (value.request().method() !== "POST") return;
    const path = new URL(value.url()).pathname;
    const base = `/api/chats/${prepared.id}/computer-use`;
    if (path === `${base}/operation`)
      pendingResponses.push(value.json().then((body) => packets.push(body)));
    if (path === `${base}/preview/stop`)
      pendingResponses.push(
        value
          .json()
          .then((body) => stops.push({ status: value.status(), body })),
      );
  };
  page.on("response", response);
  try {
    const capabilities = await page.evaluate(
      async ({ chatId }) => {
        const { createComputerUseClient } =
          await import("/src/lib/computer-use-client.ts");
        const client = createComputerUseClient(chatId),
          lease = await client.open();
        window.actualComputerUse = { client, lease, chatId };
        const value = await client.operation(lease, {
          operation: "capabilities.get",
        });
        return {
          lease,
          content: value.content,
          bytes: value.bytes?.length ?? null,
        };
      },
      { chatId: prepared.id },
    );
    assert.equal(capabilities.lease.workerId, prepared.workerId);
    assert.equal(
      capabilities.content.status,
      "ok",
      JSON.stringify(capabilities.content),
    );
    assert.equal(capabilities.content.operation, "capabilities.get");
    assert.equal(capabilities.content.data.protocolVersion, 1);
    assert.equal(capabilities.bytes, null);
    if (prepared.fakeCapture)
      assert.equal(capabilities.content.data.backend, "fake");
    const phaseResult = {
      phase,
      capabilities: capabilities.content.data,
    };
    (result.computerUse ??= []).push(phaseResult);
    phaseResult.effects = await actualEffects(
      page,
      prepared.workerId,
      prepared.fakeCapture && !approvals,
    );
    if (prepared.fakeCapture && !approvals) {
      phaseResult.capture = await actualFakeCapture(page);
      assert.equal(phaseResult.capture.binding.chatId, prepared.id);
      result.steps.push(
        "existing browser approves and explicitly retries fake inventory, session and snapshot through the full worker and opens an authenticated PNG",
      );
    }
    if (prepared.fakeCapture && approvals) {
      const prior = result.computerUse[0];
      assert.deepEqual(phaseResult.effects.initial, prior.effects.restored);
      const retained = await page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
            chatId,
          }),
        prepared.id,
      );
      phaseResult.retainedCaptureApprovals = prior.capture.approvals.map(
        ({ id }) => {
          const row = retained.find((entry) => entry.id === id);
          assert.equal(row?.status, "resolved");
          assert.equal(row.response.scope, "session");
          return id;
        },
      );
    }
    result.steps.push(
      `existing computer-use client decrypts real native capabilities through the full worker (${phase})`,
    );
    if (approvals) {
      await page.evaluate(() => {
        const c = window.actualComputerUse;
        c.pending = c.client
          .operation(c.lease, { operation: "targets.list" })
          .then(
            (value) => {
              c.outcome = { value: value.content };
            },
            (error) => {
              c.outcome = { error: error.message, code: error.code };
            },
          );
      });
      const observed = await eventually(
        () =>
          page.evaluate(async () => {
            const c = window.actualComputerUse;
            const rows = await (
              await import("/src/lib/api/chats.ts")
            ).getAgentInteractionRequests({
              chatId: c.chatId,
              status: "pending",
            });
            return { rows, outcome: c.outcome ?? null };
          }),
        (value) =>
          assert.ok(
            value.rows.some((row) => row.payload.kind === "permissions") ||
              value.outcome,
          ),
        45000,
      );
      const pending = observed.rows.find(
        (row) => row.payload.kind === "permissions",
      );
      assert.ok(pending, JSON.stringify(observed));
      const wire = await page.evaluate(
        async (id) =>
          (await import("/src/lib/api-client.ts")).request(
            `/api/agent-requests/${id}`,
          ),
        pending.id,
      );
      assert.equal("payload" in wire, false);
      assert.ok(wire.protectedPayload.envelope.ciphertext);
      await page.evaluate(
        async (id) =>
          (
            await import("/src/lib/api/chats.ts")
          ).respondToAgentInteractionRequest(id, {
            idempotencyKey: crypto.randomUUID(),
            response: {
              kind: "permissions",
              permissions: {},
              scope: "turn",
              strictAutoReview: false,
            },
          }),
        pending.id,
      );
      const declined = await page.evaluate(async () => {
        const c = window.actualComputerUse;
        await c.pending;
        return c.outcome;
      });
      assert.equal(declined.value?.status, "error", JSON.stringify(declined));
      assert.equal(declined.value?.operation, "targets.list");
      const retained = await page.evaluate(
        async (id) =>
          (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
            chatId: id,
          }),
        prepared.id,
      );
      assert.equal(
        retained.find((row) => row.id === pending.id)?.status,
        "resolved",
      );
      result.computerUse.at(-1).declined = declined.value;
      result.steps.push(
        "real full-worker CUA approval is durably encrypted, declined through the existing browser API and returned as a sealed result",
      );
      await page.evaluate(async () => {
        const c = window.actualComputerUse;
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({ computerUseEnabled: false });
        await c.client.stop(c.lease);
        c.client.dispose();
      });
      const rejected = await page.evaluate(async (id) => {
        const client = (
          await import("/src/lib/computer-use-client.ts")
        ).createComputerUseClient(id);
        try {
          await client.open();
          return { accepted: true };
        } catch (error) {
          return { status: error.status, message: error.message };
        } finally {
          client.dispose();
        }
      }, prepared.id);
      assert.equal(rejected.status, 403, JSON.stringify(rejected));
      const reopened = await page.evaluate(async (id) => {
        await (
          await import("/src/lib/api/settings.ts")
        ).updateSettings({ computerUseEnabled: true });
        const client = (
            await import("/src/lib/computer-use-client.ts")
          ).createComputerUseClient(id),
          lease = await client.open();
        try {
          const value = await client.operation(lease, {
            operation: "capabilities.get",
          });
          if (value.content.status !== "ok")
            throw new Error(JSON.stringify(value.content));
          return lease;
        } finally {
          await client.stop(lease);
          client.dispose();
        }
      }, prepared.id);
      assert.notEqual(reopened.leaseId, capabilities.lease.leaseId);
      phaseResult.reopened = reopened;
      result.steps.push(
        "current feature revocation rejects new previews, permits retained Stop and recovers with a fresh full-worker lease",
      );
    } else
      await page.evaluate(async () => {
        const c = window.actualComputerUse;
        await c.client.stop(c.lease);
        c.client.dispose();
      });
    await Promise.all(pendingResponses);
    assert.ok(packets.length > 0);
    for (const packet of packets) {
      assert.ok(packet.response?.protectedContent?.envelope?.ciphertext);
      assert.equal("data" in packet.response, false);
      assert.equal("content" in packet.response, false);
      for (const [sequence, chunk] of packet.chunks.entries()) {
        assert.equal(chunk.operationId, packet.response.operationId);
        assert.equal(chunk.sequence, sequence);
        assert.ok(chunk.protectedContent.envelope.ciphertext);
      }
    }
    assert.equal(
      packets.filter(({ chunks }) => chunks.length > 0).length,
      phaseResult.capture ? 1 : 0,
    );
    if (prepared.fakeCapture) {
      for (const marker of ["fake-monitor", "CUA fixture monitor"])
        assert.ok(!JSON.stringify(packets).includes(marker));
    }
    assert.deepEqual(
      stops,
      Array.from({ length: approvals ? 2 : 1 }, () => ({
        status: 200,
        body: { closed: true },
      })),
    );
    phaseResult.stops = stops;
    result.computerUse.at(-1).wirePackets = packets;
  } finally {
    page.off("response", response);
    await page
      .evaluate(async () => {
        const c = window.actualComputerUse;
        if (c) {
          try {
            await c.client.stop(c.lease);
          } catch {}
          c.client.dispose();
          delete window.actualComputerUse;
        }
      })
      .catch(() => {});
  }
}
