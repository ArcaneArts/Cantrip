// Existing browser encryption/client and full worker/native capability discovery.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function prepareActualComputerUse({
  page,
  projectId,
  workerId,
  result,
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
  const prepared = { id: chat.id, title, workerId };
  await actualComputerUse({
    page,
    prepared,
    result,
    phase: "connected",
    approvals: false,
  });
  return prepared;
}

export async function actualComputerUse({
  page,
  prepared,
  result,
  phase,
  approvals = true,
}) {
  const packets = [],
    pendingPackets = [];
  const response = (value) => {
    if (
      value.request().method() === "POST" &&
      new URL(value.url()).pathname ===
        `/api/chats/${prepared.id}/computer-use/operation`
    )
      pendingPackets.push(value.json().then((body) => packets.push(body)));
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
    (result.computerUse ??= []).push({
      phase,
      capabilities: capabilities.content.data,
    });
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
      await page.evaluate(async (id) => {
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
        } finally {
          await client.stop(lease);
          client.dispose();
        }
      }, prepared.id);
      result.steps.push(
        "current feature revocation rejects new previews, permits retained Stop and recovers with a fresh full-worker lease",
      );
    } else
      await page.evaluate(async () => {
        const c = window.actualComputerUse;
        await c.client.stop(c.lease);
        c.client.dispose();
      });
    await Promise.all(pendingPackets);
    assert.ok(packets.length > 0);
    for (const packet of packets) {
      assert.ok(packet.response?.protectedContent?.envelope?.ciphertext);
      assert.equal("data" in packet.response, false);
      assert.equal("content" in packet.response, false);
    }
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
