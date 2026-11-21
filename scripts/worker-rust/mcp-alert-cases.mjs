import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decryptEndpointContentPayload } from "../../packages/crypto/dist/index.js";
import { projectAlertDetailSchema } from "../../packages/protocol/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { managedMcpClient, managedMcpTurn } from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpAlerts({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  alertKey,
  serverDiagnostics,
}) {
  const { profile, model } = await createModel("Managed MCP Alert fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl, projectUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Managed MCP Alert caller",
  });
  const attachment = {
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatId,
    chatUrl,
    projectUrl,
  };
  const invoke = managedMcpClient(attachment);
  const inbox = async () =>
    (await call("GET", projectUrl + "/alerts", 200)).items;
  const counts = () => call("GET", "/api/project-alerts/counts", 200);
  const open = async ({ context, protectedContent: opaque }) => {
    const bytes = await decryptEndpointContentPayload({
      ownerId,
      keyRevision,
      componentKey: alertKey,
      context,
      opaque,
    });
    try {
      return projectAlertDetailSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } finally {
      bytes.fill(0);
    }
  };
  assert.deepEqual(await inbox(), []);
  await invoke("context_get", {});
  const settings = await eventually(
    () => call("GET", chatUrl + "/native-settings", 200),
    (state) => assert.ok(state.binding && state.effective),
  );
  await call("PATCH", chatUrl + "/permission-profile", 200, {
    id: ":read-only",
    bindingId: settings.binding.bindingId,
    expectedRevision: settings.permissionPolicy?.revision ?? "0",
    operationId: randomUUID(),
  });
  await eventually(
    () => call("GET", chatUrl + "/native-settings", 200),
    (state) => assert.equal(state.permissionPolicy?.effectiveId, ":read-only"),
  );
  const attached = await invoke("context_get", {});
  assert.equal(attached.data.context.permissionProfileId, ":read-only");

  const key = randomUUID();
  const detail = {
    title: "Private fixture Alert title 🌲",
    message: "Private fixture blocker details 🧭",
    nextStep: "Private fixture resolution step",
  };
  let first, raised;
  const updated = { ...detail, message: "Updated protected blocker" };
  await managedMcpTurn(attachment, [
    {
      name: "alert_raise",
      args: { key, revision: 1, ...detail },
      async verify(result) {
        raised = result;
        assert.equal(raised.mutated, true);
        assert.equal(raised.data.status, "open");
        assert.equal(raised.data.revision, 1);
        assert.equal(raised.data.key, key);
        [first] = await inbox();
        assert.equal(first.id, raised.data.id);
        assert.equal(first.kind, "blocked");
        assert.equal(first.episodeId, key);
        assert.equal(first.source, "agent");
        assert.equal(first.sourceId, chatId);
        assert.deepEqual(first.target, { kind: "chat", chatId, turnId: null });
        const { serverId, ...context } = first.protectedDetail.context;
        assert.ok(serverId);
        assert.deepEqual(context, {
          domain: "alert-content",
          workerId,
          scopeId: chatId,
          operationId: key,
          operation: "agent-alert",
          direction: "stored",
          sequence: 1,
        });
        assert.deepEqual(await open(first.protectedDetail), detail);
        for (const marker of Object.values(detail)) {
          assert.ok(!JSON.stringify(first).includes(marker));
          assert.ok(!serverDiagnostics().includes(marker));
        }
        assert.deepEqual(
          (await counts()).map(({ count }) => count),
          [1],
        );
      },
    },
    {
      name: "alert_raise",
      args: { key, revision: 1, ...detail },
      async verify(replay) {
        assert.deepEqual(replay.data, raised.data);
        assert.deepEqual(await inbox(), [first]);
      },
    },
    {
      name: "alert_raise",
      args: { key, revision: 2, kind: "action-required", ...updated },
      async verify(result) {
        assert.equal(result.data.id, first.id);
        assert.equal(result.data.revision, 2);
        const [current] = await inbox();
        assert.equal(current.kind, "action-required");
        assert.equal(current.protectedDetail.context.sequence, 2);
        assert.deepEqual(await open(current.protectedDetail), updated);
      },
    },
    {
      name: "alert_resolve",
      args: { key, revision: 3 },
      async verify(result) {
        assert.deepEqual(result.data, {
          id: first.id,
          key,
          status: "resolved",
          revision: 3,
        });
        assert.deepEqual(await inbox(), []);
        assert.deepEqual(await counts(), []);
      },
    },
    {
      name: "alert_raise",
      args: { key, revision: 4, ...detail },
      async verify(result) {
        assert.deepEqual(result.data, {
          id: first.id,
          key,
          status: "resolved",
          revision: 3,
        });
        assert.deepEqual(await inbox(), []);
        assert.deepEqual(await counts(), []);
      },
    },
  ]);
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      suite: "native-managed-mcp-alerts",
      passed: true,
      readOnlyAttachment: true,
      protectedRevisionedAlerts: true,
      retryAndResolution: true,
    }),
  );
}
