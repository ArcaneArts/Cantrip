import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
  encryptPrivateDisplayLabel,
  encryptSurfacePrivateState,
} from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { managedMcpClient, managedMcpTurn } from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpExplorer({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  surfaceKey,
  interactionKey,
  data,
}) {
  const { profile, model } = await createModel("Managed MCP Explorer");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl, projectUrl, workspaceId } =
    await createPreparedProjectChat({
      call,
      eventually,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      title: "Managed MCP Explorer",
    });
  const projectId = projectUrl.split("/").at(-1);
  const projectRoot = path.join(
    data,
    "workspaces",
    workspaceId,
    "folders",
    projectId,
  );
  const directory = "mcp-explorer-private";
  const file = directory + "/01-note.md";
  const original = "A🛠 original Explorer text\n";
  const replacement = "Replacement text from managed MCP 🔐\n";
  await mkdir(path.join(projectRoot, directory));
  await writeFile(path.join(projectRoot, file), original);
  await writeFile(path.join(projectRoot, directory, "02-note.txt"), "second");

  const serverId = (await call("GET", "/api/bootstrap", 200)).server.id;
  const id = randomUUID();
  await call("POST", projectUrl + "/explorers", 201, {
    id,
    titleProtection: await encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind: "explorer",
      rowId: id,
      componentKey: labelKey,
      label: "Private MCP Explorer 🧭",
    }),
    stateProtection: await encryptSurfacePrivateState({
      ownerId,
      keyRevision,
      componentKey: surfaceKey,
      context: {
        serverId,
        resource: "explorer-row",
        resourceId: id,
        operationId: null,
        recordKind: "explorer-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "explorer-state" },
        selectedPath: null,
      },
    }),
    attachToTabLayout: false,
  });
  const target = {
    kind: "surface",
    projectId,
    surfaceKind: "explorer",
    surfaceId: id,
  };
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
  async function approveWrite() {
    const [pending] = await eventually(
      () =>
        call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
      (items) => assert.equal(items.length, 1),
    );
    const material = {
      ownerId,
      keyRevision,
      requestKey: pending.requestKey,
      componentKey: interactionKey,
    };
    const classification = pending.classification;
    const { payload } = await decryptInteractionRequestContent({
      ...material,
      encrypted: pending.protectedPayload,
      publicClassification: classification,
    });
    assert.match(JSON.stringify(payload), /explorer[_ ]write|Explorer file/iu);
    let response;
    if (payload.kind === "mcpElicitation") {
      response = { kind: payload.kind, action: "accept", content: null };
    } else {
      assert.equal(payload.kind, "userInput");
      const [question] = payload.questions;
      assert.ok(question.options.some(({ label }) => label === "Allow"));
      response = {
        kind: payload.kind,
        answers: { [question.id]: { answers: ["Allow"] } },
      };
    }
    const result = await call(
      "POST",
      `/api/agent-requests/${pending.id}/respond`,
      200,
      {
        idempotencyKey: randomUUID(),
        classification,
        protectedResponse: await encryptInteractionResponseContent({
          ...material,
          content: { version: 1, classification, response },
        }),
      },
    );
    assert.equal(result.status, "resolved");
  }
  async function write(args, error) {
    const [result] = await managedMcpTurn(attachment, [
      { name: "explorer_write", args, error, afterInvoke: approveWrite },
    ]);
    return result;
  }
  const first = await invoke("explorer_list", {
    target,
    path: directory,
    limit: 1,
  });
  assert.deepEqual(first.target, target);
  assert.equal(first.summary, "Found 1 Explorer entry.");
  assert.equal(first.mutated, false);
  assert.deepEqual(
    first.data.entries.map(({ name }) => name),
    ["01-note.md"],
  );
  assert.equal(first.data.cursor, 0);
  assert.equal(first.data.nextCursor, 1);
  assert.equal(first.data.total, 2);
  assert.equal(first.data.truncated, true);
  const second = await invoke("explorer_list", {
    target,
    path: directory,
    limit: 1,
    cursor: first.data.nextCursor,
  });
  assert.deepEqual(
    second.data.entries.map(({ name }) => name),
    ["02-note.txt"],
  );
  assert.equal(second.data.nextCursor, null);
  assert.equal(second.data.truncated, false);

  const preview = await invoke("explorer_read", {
    target,
    path: file,
    maxChars: 3,
  });
  assert.equal(preview.summary, "Read " + file + " (content truncated).");
  assert.equal(preview.data.content, original.slice(0, 3));
  assert.equal(preview.data.truncated, true);
  assert.ok(preview.data.version);
  const saved = await write({
    target,
    path: file,
    content: replacement,
    version: preview.data.version,
  });
  assert.equal(saved.summary, "Saved " + file + ".");
  assert.equal(saved.mutated, true);
  assert.equal(saved.continuationScheduled, false);
  assert.deepEqual(saved.target, target);
  assert.equal(saved.worktreeId, first.worktreeId);
  assert.equal(saved.data.path, file);
  assert.notEqual(saved.data.version, preview.data.version);
  assert.ok(!Object.hasOwn(saved.data, "content"));
  assert.equal(
    await readFile(path.join(projectRoot, file), "utf8"),
    replacement,
  );

  await write(
    {
      target,
      path: file,
      content: "stale replacement",
      version: preview.data.version,
    },
    /changed|version|modified/iu,
  );
  assert.equal(
    await readFile(path.join(projectRoot, file), "utf8"),
    replacement,
  );
  await invoke(
    "explorer_read",
    {
      target: { ...target, projectId: randomUUID() },
      path: file,
    },
    /target cannot receive protected operations/iu,
  );

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
  await managedMcpTurn(attachment, [
    {
      name: "explorer_read",
      args: { target, path: file },
      async verify(reopened) {
        assert.equal(reopened.data.content, replacement);
        assert.equal(reopened.data.version, saved.data.version);
        assert.equal(reopened.data.truncated, false);

        const dir = path.join(data, "agent-mcp-bindings");
        const [session] = await readdir(dir);
        const connection = JSON.parse(
          await readFile(path.join(dir, session, "connection.json"), "utf8"),
        );
        const rpc = async (method, params) => {
          const response = await fetch(
            connection.endpoint + "/v1/mcp/" + connection.bindingId,
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + connection.credential,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              signal: AbortSignal.timeout(15_000),
            },
          );
          assert.equal(response.status, 200);
          const reply = await response.json();
          assert.ok(reply.result, JSON.stringify(reply));
          return reply.result;
        };
        const { tools } = await rpc("tools/list");
        assert.ok(tools.some(({ name }) => name === "explorer_read"));
        assert.ok(!tools.some(({ name }) => name === "explorer_write"));
        const truncated = await rpc("tools/call", {
          name: "explorer_read",
          arguments: {
            target,
            path: file,
            maxChars: replacement.indexOf("🔐") + 1,
          },
        });
        assert.equal(
          truncated.structuredContent.data.content,
          replacement.slice(0, replacement.indexOf("🔐") + 1),
        );
        const denied = await rpc("tools/call", {
          name: "explorer_write",
          arguments: {
            target,
            path: file,
            content: "read-only replacement",
            version: saved.data.version,
          },
        });
        assert.equal(denied.isError, true);
        assert.equal(
          await readFile(path.join(projectRoot, file), "utf8"),
          replacement,
        );
      },
    },
  ]);
  console.log(
    JSON.stringify({ suite: "native-managed-mcp-explorer", passed: true }),
  );
}
