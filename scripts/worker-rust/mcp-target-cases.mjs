import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encryptPrivateDisplayLabel } from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { managedMcpClient } from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpTargets({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
}) {
  const { profile, model } = await createModel("Managed MCP target fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const title = "Private calling surface title 🌲";
  const secondTitle = "Private second surface title 🧭";
  const { chatId, chatUrl, projectUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title,
  });
  const sibling = randomUUID();
  await call("POST", projectUrl + "/chats", 201, {
    id: sibling,
    titleProtection: await encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind: "chat",
      rowId: sibling,
      componentKey: labelKey,
      label: secondTitle,
    }),
    autoTitle: false,
  });
  await eventually(
    () => call("GET", `/api/chats/${sibling}/preparation`, 200),
    (state) => assert.equal(state.preparation?.phase, "ready"),
  );
  const projectId = projectUrl.split("/").at(-1);
  const invoke = managedMcpClient({
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatId,
    chatUrl,
    projectUrl,
  });

  const page = (await invoke("target_list", { kind: "chat", limit: 1 })).data;
  assert.equal(page.projectId, projectId);
  assert.equal(page.cursor, 0);
  assert.equal(page.nextCursor, 1);
  assert.equal(page.total, 2);
  assert.equal(page.truncated, true);
  assert.equal(page.targets.length, 1);
  const last = (
    await invoke("target_list", { kind: "chat", cursor: page.nextCursor })
  ).data;
  assert.equal(last.cursor, 1);
  assert.equal(last.nextCursor, null);
  assert.equal(last.total, 2);
  const targets = [...page.targets, ...last.targets];
  assert.deepEqual(
    new Map(targets.map((row) => [row.target.surfaceId, row.title])),
    new Map([
      [chatId, title],
      [sibling, secondTitle],
    ]),
  );
  for (const row of targets) {
    assert.equal(row.target.kind, "surface");
    assert.equal(row.target.projectId, projectId);
    assert.equal(row.resourceKind, "chat");
    assert.equal(row.placement.workerId, workerId);
    assert.ok(!("titleProtection" in row));
  }
  const all = (await invoke("target_list", {})).data;
  assert.equal(all.cursor, 0);
  assert.equal(all.nextCursor, null);
  const enrolled = all.targets.find((row) => row.target.kind === "worker");
  assert.equal(enrolled?.target.workerId, workerId);
  assert.equal(enrolled.title, enrolled.worker.name);
  const raw = await call("GET", projectUrl + "/execution-targets", 200);
  for (const row of targets) {
    const opaque = raw.targets.find(
      ({ target }) => target.surfaceId === row.target.surfaceId,
    );
    assert.equal(opaque?.title, null);
    assert.ok(opaque.titleProtection);
  }

  const { target } = targets.find((row) => row.target.surfaceId === sibling);
  const inspected = await invoke("target_inspect", { target });
  assert.deepEqual(inspected.target, target);
  assert.deepEqual(inspected.data.target, target);
  assert.equal(inspected.data.availability, "available");
  assert.deepEqual(inspected.data.placement.surface, {
    kind: "chat",
    id: sibling,
  });
  assert.equal(inspected.data.worker.workerId, workerId);
  assert.equal(inspected.data.stateRevision, null);
  assert.ok(!("serverId" in inspected.data));
  await invoke(
    "target_inspect",
    { target: { ...target, projectId: randomUUID() } },
    /different project/u,
  );
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      suite: "native-managed-mcp-targets",
      passed: true,
      pagedCatalogAndPrivateTitles: true,
      admittedTargetInspection: true,
      foreignProjectRejected: true,
    }),
  );
}
