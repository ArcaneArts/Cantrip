import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  decryptEndpointContentPayload,
  encryptInteractionResponseContent,
} from "../../packages/crypto/dist/index.js";
import { LiveProbe, initialize } from "../server-rust/live-sockets.mjs";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { managedMcpClient } from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpClientControls({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  notificationKey,
  interactionKey,
  data,
  server,
}) {
  const { profile, model } = await createModel("Managed MCP client control");
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
    title: "Managed MCP client controls",
  });
  const projectId = projectUrl.split("/").at(-1);
  const target = {
    kind: "surface",
    projectId,
    surfaceKind: "chat",
    surfaceId: chatId,
  };
  const project = { kind: "project", projectId };
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
  const noClient = await invoke("client_focus_project", {});
  assert.equal(noClient.data.status, "unavailable");
  assert.equal(noClient.mutated, false);
  const live = new LiveProbe({ server, client: () => ({ cookies: [] }) });
  await live.open();
  try {
    const message = initialize();
    message.client.controlCapabilities = [
      "focus-project",
      "focus-surface",
      "notify",
      "show-interaction",
    ];
    live.send(message);
    await live.message(({ type }) => type === "ready");
    await live.subscribed("fixture-control", [
      project,
      { kind: "chat", chatId },
    ]);
    async function control(work, kind, status, verify) {
      const pending = work();
      const frame = await Promise.race([
        live.message(({ type }) => type === "client-control-request"),
        pending.then(() =>
          assert.fail("The tool returned before a Live control arrived."),
        ),
      ]);
      assert.equal(frame.command.kind, kind);
      assert.equal(frame.command.projectId, projectId);
      await verify?.(frame.command);
      live.send({
        type: "client-control-ack",
        correlationId: frame.correlationId,
        status,
        detail: "Private client receipt detail",
      });
      const result = await pending;
      assert.deepEqual(result.data, {
        correlationId: frame.correlationId,
        status,
      });
      assert.equal(result.mutated, status === "applied");
      return result;
    }
    const focusProject = await control(
      () => invoke("client_focus_project", {}),
      "focus-project",
      "declined",
    );
    assert.deepEqual(focusProject.target, project);
    const focusChat = await control(
      () => invoke("client_focus_surface", { target }),
      "focus-surface",
      "applied",
      (command) =>
        assert.deepEqual(command, {
          kind: "focus-surface",
          projectId,
          surfaceKind: "chat",
          surfaceId: chatId,
        }),
    );
    assert.deepEqual(focusChat.target, target);
    assert.equal(focusChat.worktreeId, focusProject.worktreeId);

    const title = "Private agent notification 🧭";
    const body = "Protected fixture message 🌲";
    const serverId = (await call("GET", "/api/bootstrap", 200)).server.id;
    const notification = await control(
      () =>
        invoke("client_notify", { title: " " + title + " ", message: body }),
      "notify",
      "applied",
      async ({ protectedContent: opaque, operationId, ...command }) => {
        assert.deepEqual(command, { kind: "notify", projectId, workerId });
        assert.ok(!JSON.stringify(opaque).includes(title));
        const bytes = await decryptEndpointContentPayload({
          ownerId,
          keyRevision,
          componentKey: notificationKey,
          opaque,
          context: {
            domain: "client-control-content",
            serverId,
            workerId,
            scopeId: projectId,
            operationId,
            operation: "client.notify",
            direction: "event",
            sequence: 0,
          },
        });
        try {
          assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), {
            title,
            message: body,
            level: "info",
          });
        } finally {
          bytes.fill(0);
        }
      },
    );
    assert.deepEqual(notification.target, project);
    assert.ok(!server.diagnostics().includes(body));
    const requests = () =>
      live.history.filter(({ type }) => type === "client-control-request")
        .length;
    const before = requests();
    await invoke(
      "client_focus_surface",
      { target: { ...target, projectId: randomUUID() } },
      /another project/u,
    );
    await invoke(
      "client_show_interaction",
      { interactionId: randomUUID() },
      /not pending in the bound Cantrip chat/u,
    );
    assert.equal(requests(), before);

    const shown = await showPendingInteraction({
      call,
      eventually,
      model,
      profile,
      encryptedTurn,
      control,
      chatId,
      chatUrl,
      ownerId,
      keyRevision,
      interactionKey,
      data,
    });
    assert.deepEqual(shown.target, target);
    assert.deepEqual(model.failures, []);
  } finally {
    await live.close();
  }
  console.log(
    JSON.stringify({
      suite: "native-managed-mcp-client-controls",
      passed: true,
      encryptedNotification: true,
      acknowledgedProjectAndSurfaceFocus: true,
      pendingInteractionStayedPending: true,
    }),
  );
}

async function showPendingInteraction({
  call,
  eventually,
  model,
  profile,
  encryptedTurn,
  control,
  chatId,
  chatUrl,
  ownerId,
  keyRevision,
  interactionKey,
  data,
}) {
  await call("PATCH", chatUrl + "/plan", 200, { mode: "plan" });
  const question = model.reply({ hold: true });
  const answer = model.reply({ text: "Processed the fixture choice." });
  try {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn(
        "Ask which fixture option to use.",
        profile.id,
        "plan",
      ),
    );
    const request = await eventually(
      () => question.request,
      (value) => assert.ok(value),
    );
    const tool = modelFunctions(request.input.tools).find(
      ({ name }) => name === "request_user_input",
    );
    assert.ok(tool);
    question.calls = [
      {
        ...tool,
        arguments: {
          isBlocking: true,
          questions: [
            {
              id: "choice",
              header: "Fixture choice",
              question: "Which option should the fixture use?",
              options: [
                {
                  label: "First",
                  description: "Use the first fixture option.",
                },
                {
                  label: "Second",
                  description: "Use the second fixture option.",
                },
              ],
            },
          ],
        },
      },
    ];
    question.release();
    const [pending] = await eventually(
      () =>
        call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
      (items) => assert.equal(items.length, 1),
    );
    assert.equal(pending.classification.kind, "userInput");
    const directory = path.join(data, "agent-mcp-bindings");
    const [session] = await readdir(directory);
    const connection = JSON.parse(
      await readFile(path.join(directory, session, "connection.json"), "utf8"),
    );
    const invoke = async () => {
      const response = await fetch(
        connection.endpoint + "/v1/mcp/" + connection.bindingId,
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + connection.credential,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "client_show_interaction",
              arguments: { interactionId: pending.id },
            },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const message = await response.json();
      assert.equal(response.status, 200);
      assert.equal(
        message.result?.isError,
        undefined,
        JSON.stringify(message.result),
      );
      return message.result.structuredContent;
    };
    const shown = await control(
      invoke,
      "show-interaction",
      "applied",
      (command) => {
        assert.equal(command.chatId, chatId);
        assert.equal(command.interactionId, pending.id);
      },
    );
    const url = "/api/agent-requests/" + pending.id;
    assert.equal((await call("GET", url, 200)).status, "pending");
    assert.equal(answer.entered, false);
    const classification = pending.classification;
    const settled = await call("POST", url + "/respond", 200, {
      idempotencyKey: randomUUID(),
      classification,
      protectedResponse: await encryptInteractionResponseContent({
        ownerId,
        keyRevision,
        componentKey: interactionKey,
        requestKey: pending.requestKey,
        content: {
          version: 1,
          classification,
          response: {
            kind: "userInput",
            answers: { choice: { answers: ["First"] } },
          },
        },
      }),
    });
    assert.equal(settled.status, "resolved");
    await eventually(
      () => answer.request,
      (request) => assert.equal(request?.completed, true),
    );
    return shown;
  } finally {
    question.release();
  }
}
