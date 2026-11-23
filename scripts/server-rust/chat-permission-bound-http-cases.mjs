import assert from "node:assert/strict";
import * as p from "../../packages/protocol/dist/index.js";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { settingsIntent } from "./native-settings-fixtures.mjs";
import { customizationId as id } from "./chat-customization-http-worker.mjs";
import { literal, json } from "./project-target-state.mjs";

export async function runBoundPermissionHttpCases({
  h,
  result,
  controller,
  base,
  permissions,
  choice,
  sql,
}) {
  const state = await h.visit(
    "bind actual protected native settings",
    "POST",
    base + "/native-settings/refresh",
  );
  assert.ok(state.binding);
  const binding = state.binding.bindingId;
  await choice(
    "obsolete permission binding",
    {
      id: ":workspace",
      bindingId: "obsolete",
      operationId: id(100),
      expectedRevision: "0",
    },
    409,
  );
  for (const [n, mode] of [
    [101, "requesting"],
    [102, "queued"],
    [103, "applied"],
    [104, "rejected"],
    [105, "uncertain"],
  ]) {
    controller.setPermissionMode(mode);
    const receipt = await choice(`bound permission receipt ${mode}`, {
      id: null,
      bindingId: binding,
      operationId: id(n),
      expectedRevision: "9007199254740993",
    });
    assert.equal(receipt.status, mode);
    assert.equal(
      result.permissionWrites.at(-1).permissionTransition.expectedRevision,
      "9007199254740993",
    );
    assert.deepEqual(result.permissionWrites.at(-1).patch, {
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      applyAt: "quiescent",
    });
  }
  for (const [n, mode] of [
    [110, "invalid"],
    [111, "wrong-id"],
    [112, "error"],
  ]) {
    controller.setPermissionMode(mode);
    await choice(
      `bound permission ${mode} without durable rejection`,
      {
        id: ":workspace",
        bindingId: binding,
        operationId: id(n),
        expectedRevision: "0",
      },
      500,
    );
  }
  for (const [n, code] of [
    "permission-transition-pending",
    "permission-revision-conflict",
    "permission-policy-replaced",
    "settings-binding-replaced",
    "other-rejection",
  ].entries()) {
    controller.setPermissionMode("reject:" + code);
    const rejected = await choice(
      `permission rejection receipt ${code}`,
      {
        id: ":workspace",
        bindingId: binding,
        operationId: id(120 + n),
        expectedRevision: "0",
      },
      409,
    );
    assert.equal(rejected.code, code);
  }
  controller.setPermissionMode("applied");
  const intent = (operationId) => ({
    ...settingsIntent,
    operationId,
    source: { ...settingsIntent.source, workerId: worker },
    permissionTransition: {
      selectedId: null,
      resolvedSelectedId: ":workspace",
      effectiveId: ":workspace",
      expectedRevision: "0",
    },
  });
  for (const status of [
    "accepted",
    "dispatched",
    "applied",
    "rejected",
    "uncertain",
  ]) {
    const modified = p.nativeSettingsStateSchema.parse({
      ...state,
      desired: intent("desired-permission"),
      desiredStatus: status,
      pending: [
        {
          desiredRevision: "1",
          bindingId: binding,
          intent: intent("pending-permission"),
          status: "dispatched",
        },
      ],
    });
    await sql(
      `UPDATE native_settings_states SET state=${json(modified)} WHERE chat_id=${literal(chat)}`,
    );
    const view = await h.visit(
      `desired permission transition ${status}`,
      "GET",
      permissions,
    );
    assert.equal(view.transition.operationId, "desired-permission");
    assert.equal(view.transition.status, status);
  }
  const pendingOnly = p.nativeSettingsStateSchema.parse({
    ...state,
    desired: { ...settingsIntent, operationId: "non-permission" },
    desiredStatus: "applied",
    pending: [
      {
        desiredRevision: "1",
        bindingId: binding,
        intent: intent("pending-first"),
        status: "accepted",
      },
      {
        desiredRevision: "2",
        bindingId: binding,
        intent: intent("pending-last"),
        status: "dispatched",
      },
    ],
  });
  await sql(
    `UPDATE native_settings_states SET state=${json(pendingOnly)} WHERE chat_id=${literal(chat)}`,
  );
  const pendingView = await h.visit(
    "last pending permission transition",
    "GET",
    permissions,
  );
  assert.equal(pendingView.transition.operationId, "pending-last");
  assert.equal(pendingView.transition.status, "dispatched");
  await sql(
    `UPDATE native_settings_states SET state=${json(state)} WHERE chat_id=${literal(chat)}`,
  );
}
