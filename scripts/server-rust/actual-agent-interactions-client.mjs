// Existing browser SDK -> production server -> unchanged full worker -> actual
// Codex command approval. Only the public model HTTP response is controlled.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualAgentInteractionsClient({
  page,
  fixture,
  projectId,
  chatId,
  configuration,
  model,
  result,
  requests,
}) {
  const marker = "Private actual native approval reason 🌲",
    prompt = "Private actual native approval prompt 🔑",
    answer = "Private actual native approval completed 🍄",
    shellOutput = "CANTRIP_NATIVE_APPROVAL_ACCEPTED";
  const baseline = model.requests.filter((r) => r.method === "POST").length,
    available = model.requests
      .find((r) => r.method === "POST")
      .input.tools.flatMap((tool) =>
        tool.type === "namespace"
          ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name }))
          : [tool],
      ),
    tool = available.find((entry) => entry.name === "exec_command");
  assert.ok(tool, "actual native runtime advertises its command tool");
  model.reply({
    calls: [
      {
        name: tool.name,
        namespace: tool.namespace,
        arguments: {
          cmd: `echo ${shellOutput}`,
          login: false,
          sandbox_permissions: "require_escalated",
          justification: marker,
          max_output_tokens: 300,
        },
      },
    ],
  });
  const final = model.reply({ text: answer });
  const admitted = await page.evaluate(
    async ({ chatId, configuration, prompt }) =>
      (await import("/src/lib/api/chats.ts")).startTurn(
        chatId,
        prompt,
        configuration,
      ),
    { chatId, configuration, prompt },
  );
  assert.equal(admitted.status, "queued");
  const approval = await eventually(
    () =>
      page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
            chatId,
            status: "pending",
          }),
        chatId,
      ),
    (rows) =>
      assert.ok(rows.some((r) => r.payload.kind === "commandExecution")),
    60000,
  );
  const pending = approval.find((r) => r.payload.kind === "commandExecution");
  assert.equal(pending.status, "pending");
  assert.ok(pending.payload.reason.includes(marker));
  const wire = await page.evaluate(
    async (requestId) =>
      (await import("/src/lib/api-client.ts")).request(
        `/api/agent-requests/${requestId}`,
      ),
    pending.id,
  );
  assert.equal("payload" in wire, false);
  assert.equal(wire.classification.kind, "commandExecution");
  assert.ok(wire.protectedPayload.envelope.ciphertext);
  const response = await page.evaluate(
    async ({ requestId, requestKey }) => {
      const input = {
          idempotencyKey: crypto.randomUUID(),
          response: {
            kind: "commandExecution",
            decision: "accept",
            execpolicyAmendment: null,
            networkPolicyAmendment: null,
          },
        },
        api = await import("/src/lib/api/chats.ts");
      const resolved = await api.respondToAgentInteractionRequest(
        requestId,
        input,
      );
      async function replay(idempotencyKey) {
        try {
          return {
            status: 200,
            row: await api.respondToAgentInteractionRequest(requestId, {
              ...input,
              idempotencyKey,
            }),
          };
        } catch (error) {
          return { status: error.status, error: error.message };
        }
      }
      // The worker publishes its protected resolution before RPC return too.
      // The winning write owns the durable key. An accepted HTTP reply retains
      // that winner, and only its key may replay afterwards.
      return {
        resolved,
        clientReplay: await replay(input.idempotencyKey),
        workerReplay: await replay(`native-response:${requestKey}`),
      };
    },
    { requestId: pending.id, requestKey: pending.requestKey },
  );
  assert.equal(response.resolved.status, "resolved");
  assert.equal(response.resolved.response.decision, "accept");
  assert.deepEqual(
    [response.clientReplay.status, response.workerReplay.status].sort(),
    [200, 409],
  );
  for (const replay of [response.clientReplay, response.workerReplay])
    if (replay.status === 200)
      assert.deepEqual(
        replay.row,
        response.resolved,
        "freshly encrypted SDK replay retains the durable acknowledged winner",
      );
    else assert.equal(replay.error, "Interaction request is already resolved.");
  await eventually(
    () =>
      page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).getMessages(chatId),
        chatId,
      ),
    (messages) => assert.ok(JSON.stringify(messages).includes(answer)),
    60000,
  );
  await eventually(
    () =>
      page.evaluate(
        async (projectId) =>
          (await import("/src/lib/api/chats.ts")).getChats(projectId),
        projectId,
      ),
    (rows) => assert.equal(rows.find((r) => r.id === chatId).status, "idle"),
  );
  assert.equal(final.request.completed, true);
  assert.ok(
    JSON.stringify(
      final.request.input.input.filter(
        (item) => item.type === "function_call_output",
      ),
    ).includes(shellOutput),
    "the real native tool executes only after the encrypted browser reply",
  );
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    baseline + 2,
    "durable approval replay does not execute or infer twice",
  );
  for (const value of [requests, fixture.server.diagnostics()])
    for (const privateText of [marker, prompt, answer])
      assert.equal(
        JSON.stringify(value).includes(privateText),
        false,
        "approval content remains encrypted across the server boundary",
      );
  result.agentInteractions = {
    completed: true,
    nativeCommandExecuted: true,
    encryptedRequestAndResponse: true,
    replayPreserved: true,
    modelRequests: 2,
  };
  result.steps.push(
    "the existing browser SDK decrypts a real native command approval, encrypts its reply, replays it durably and completes the unchanged worker's actual Codex turn",
  );
}
