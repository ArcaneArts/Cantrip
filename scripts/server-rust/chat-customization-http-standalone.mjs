import assert from "node:assert/strict";
import {
  settingsChat,
  settingsWorker as worker,
  otherChat as chat,
} from "./native-settings-http-fixture.mjs";
import {
  customizationId as id,
  customizationRoutes as routes,
} from "./chat-customization-http-worker.mjs";
import { literal } from "./project-target-state.mjs";

export async function runStandaloneCustomizationHttpCases({
  h,
  result,
  profile,
  controller,
}) {
  const root = "99999999-9999-4999-8999-999999999999",
    base = `/api/chats/${chat}`,
    sql = (...statements) => h.fixture.sql(statements),
    originalScope = { ...h.scope };
  await sql(
    `INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,model_id,automation_paused) SELECT ${literal(chat)},owner_id,'standalone',NULL,protected_label,${literal(worker)},${literal(root)},NULL,'inventory-provider-model-1',true FROM chats WHERE id=${literal(settingsChat)}`,
    `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES(${literal(root)},${literal(chat)},${literal(h.owner)},${literal(worker)},${literal("ctrr_" + Buffer.alloc(32, 39).toString("base64url"))},'ready')`,
    `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id) VALUES('customization-standalone-runtime',${literal(chat)},${literal(worker)},${literal(root)},'standalone-thread')`,
  );
  Object.assign(h.scope, {
    chatId: chat,
    contextKind: "standalone",
    projectId: null,
    placementId: root,
    threadId: "standalone-thread",
  });
  try {
    await h.live.subscribed("customization-standalone", [
      { kind: "chat", chatId: settingsChat },
      { kind: "chat", chatId: chat },
    ]);
    const before = result.commands.length,
      scope = {
        workerId: worker,
        projectId: null,
        chatId: chat,
        providerId: "inventory-provider",
      };
    assert.deepEqual(
      await h.visit(
        "standalone customization target",
        "GET",
        base + "/customizations/target",
        { status: 409 },
      ),
      {
        error: "This IDE-only Chat feature is unavailable in standalone Chat.",
      },
    );
    await h.visit(
      "standalone restriction precedes operation validation",
      "GET",
      base + "/skills",
      { status: 409 },
    );
    await h.visit(
      "standalone restriction precedes protected schema validation",
      "PATCH",
      base + "/customizations/skill",
      { json: {}, status: 409 },
    );
    for (const [index, [method, suffix, operation]] of routes.entries()) {
      const n = 200 + index,
        raw = await h.visit(
          "standalone " + operation,
          method,
          `${base}/${suffix}${method === "GET" ? `?operationId=${id(n)}` : ""}`,
          {
            ...(method === "GET"
              ? {}
              : { json: await controller.request(n, operation, scope) }),
            status: 409,
          },
        );
      assert.deepEqual(raw, {
        error: "This IDE-only Chat feature is unavailable in standalone Chat.",
      });
    }
    assert.equal(
      result.commands.length,
      before,
      "IDE-only standalone requests never dispatch native work",
    );
    await h.visit("standalone reasoning", "GET", base + "/reasoning");
    await h.visit(
      "standalone permission profiles",
      "GET",
      base + "/permission-profiles",
    );
    const binding = await h.visit(
      "standalone native permission binding",
      "POST",
      base + "/native-settings/refresh",
    );
    assert.equal(binding.binding.contextKind, "standalone");
    await h.visit(
      "standalone bound permission update",
      "PATCH",
      base + "/permission-profile",
      {
        json: {
          id: ":read-only",
          bindingId: binding.binding.bindingId,
          operationId: id(220),
          expectedRevision: "0",
        },
      },
    );
    if (profile === "accounts") {
      await h.visit(
        "standalone foreign customization",
        "GET",
        base + "/customizations/target",
        { client: "other", status: 404 },
      );
      await h.visit(
        "standalone foreign permissions",
        "GET",
        base + "/permission-profiles",
        { client: "other", status: 404 },
      );
    }
    await sql(
      `UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=${literal(chat)}`,
    );
    const choice = await h.visit(
      "standalone unbound permission update",
      "PATCH",
      base + "/permission-profile",
      { json: { id: ":yolo" } },
    );
    assert.equal(choice.effectiveId, ":yolo");
    const model = await h.visit(
      "standalone model update",
      "PATCH",
      base + "/model",
      { json: { modelId: "inventory-provider-model-3" } },
    );
    assert.equal(model.chatId ?? model.id, chat);
    await h.visit("standalone reasoning update", "PATCH", base + "/reasoning", {
      json: { reasoningEffort: null },
    });
    const [retained] = await h.fixture.sql(
      [],
      [
        `SELECT jsonb_build_object('modelId',model_id,'permissionProfileId',permission_profile_id,'reasoningEffort',reasoning_effort)::text result FROM chats WHERE id=${literal(chat)}`,
      ],
    );
    assert.deepEqual(retained, {
      modelId: "inventory-provider-model-3",
      permissionProfileId: ":yolo",
      reasoningEffort: null,
    });
    result.durable.push({
      label: "standalone customization configuration",
      state: retained,
    });
    result.recovery.push({
      case: "standalone-customizations-and-permission-authority",
      verified: true,
    });
  } finally {
    Object.assign(h.scope, originalScope);
    await h.live.subscribed("customization-standalone-completed", [
      { kind: "chat", chatId: settingsChat },
    ]);
  }
}
