import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import * as protocol from "../../packages/protocol/dist/automations.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifyProjectAutomations({
  call,
  eventually,
  createModel,
  encryptedTurn,
  restartWorker,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  workflowKey,
  chatKey,
  data,
}) {
  const { profile, model } = await createModel("Native automation fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  let projectId;
  let checkout;
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Scheduled automation fixture",
    async beforeChat(project) {
      projectId = project.projectId;
      checkout = path.join(
        data,
        "workspaces",
        project.workspaceId,
        "folders",
        projectId,
      );
      await writeFile(path.join(checkout, ".automation-allowed"), "fixture");
    },
  });
  const held = model.reply({ text: "The first turn finished.", hold: true });
  try {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn(
        "Hold this turn while automation becomes due.",
        profile.id,
      ),
    );
    await eventually(
      () => held.request,
      (request) => assert.ok(request),
      25_000,
    );
    await verifyDue();
  } finally {
    held.release();
  }

  async function verifyDue() {
    const base = `/api/projects/${projectId}/automations`;
    const prompt = "Private prompt for the scheduled native turn 🌱";
    const scheduledFor = new Date(Date.now() + 9_000).toISOString();
    const later = new Date(
      Date.parse(scheduledFor) + 60 * 60 * 1_000,
    ).toISOString();
    async function protect(id, field, data, schema) {
      return crypto.encryptProjectAutomationContent({
        ownerId,
        keyRevision,
        componentKey: workflowKey,
        context: { recordKind: "project-automation", recordId: id, field },
        content: { version: 1, [field]: data },
        schema,
      });
    }
    async function create(
      condition,
      {
        enabled = true,
        startsAt = scheduledFor,
        corrupt = false,
        promptText = prompt,
      } = {},
    ) {
      const id = randomUUID();
      const content = {
        protectedName: await protect(
          corrupt ? randomUUID() : id,
          "name",
          "Private automation fixture",
          protocol.projectAutomationProtectedNameSchema,
        ),
        protectedPrompt: await protect(
          id,
          "prompt",
          promptText,
          protocol.projectAutomationProtectedPromptSchema,
        ),
        protectedCondition: await protect(
          id,
          "condition",
          condition,
          protocol.projectAutomationProtectedConditionSchema,
        ),
      };
      const created = await call("POST", base, 201, {
        id,
        chatId,
        enabled,
        content,
        schedule: { kind: "interval", every: 1, unit: "hour", startsAt },
      });
      assert.equal(created.nextRunAt, enabled ? startsAt : null);
      assert.equal(created.lastStatus, "idle");
      return id;
    }
    const allowed = await create({
      type: "script",
      script: "test -f .automation-allowed",
    });
    const skipped = await create({ type: "script", script: "exit 8" });
    const missingRepository = await create({ type: "open-issues", minimum: 2 });
    const tampered = await create(
      { type: "script", script: "printf bad > .automation-must-not-run" },
      { corrupt: true },
    );
    const disabled = await create(null, { enabled: false });
    const future = await create(null, { startsAt: later });

    await eventually(
      () => call("GET", base, 200),
      (items) => {
        const listed = new Map(items.map((row) => [row.id, row]));
        for (const [id, status] of [
          [allowed, "queued"],
          [skipped, "skipped"],
          [missingRepository, "failed"],
          [tampered, "failed"],
        ]) {
          assert.equal(listed.get(id).lastStatus, status);
          assert.equal(listed.get(id).nextRunAt, later);
        }
        assert.equal(listed.get(disabled).lastStatus, "idle");
        assert.equal(listed.get(future).lastStatus, "idle");
        assert.equal(JSON.stringify(items).includes(prompt), false);
      },
      35_000,
    );
    await assert.rejects(
      readFile(path.join(checkout, ".automation-must-not-run")),
      { code: "ENOENT" },
    );
    async function queue() {
      const response = await call("GET", chatUrl + "/queue", 200);
      return response.items ?? response;
    }
    const first = await queue();
    assert.equal(first.length, 1);
    const queued = first[0];
    assert.equal(
      queued.idempotencyKey,
      `automation:${allowed}:${scheduledFor}`,
    );
    assert.equal(JSON.stringify(queued).includes(prompt), false);
    const opened = await crypto.decryptQueuedPromptProtectedContent({
      ownerId,
      promptId: queued.id,
      keyRevision: queued.protectedContent.keyRevision,
      componentKey: chatKey,
      encrypted: queued.protectedContent,
      publicClassification: queued.classification,
    });
    assert.equal(opened.text, prompt);
    const reply = model.reply({ text: "The scheduled native turn ran." });
    held.release();
    await eventually(
      () => reply.request,
      (turn) => assert.equal(turn?.completed, true),
      25_000,
    );
    assert.ok(JSON.stringify(reply.request.input.input).includes(prompt));
    await eventually(queue, (items) => assert.equal(items.length, 0), 25_000);
    const waitForIdle = () =>
      eventually(
        () => call("GET", `/api/projects/${projectId}/chats`, 200),
        (chats) => {
          const status = chats.find((chat) => chat.id === chatId)?.status;
          assert.ok(
            status && !["running", "waiting-for-approval"].includes(status),
          );
        },
        25_000,
      );
    await waitForIdle();
    const idlePrompt = "Private prompt for an idle scheduled turn";
    const idleReply = model.reply({ text: "The idle scheduled turn ran." });
    const idle = await create(null, {
      startsAt: new Date(Date.now() + 2_000).toISOString(),
      promptText: idlePrompt,
    });
    await eventually(
      () => call("GET", base, 200),
      (items) =>
        assert.equal(
          items.find((row) => row.id === idle).lastStatus,
          "started",
        ),
      30_000,
    );
    await eventually(
      () => idleReply.request,
      (turn) => assert.equal(turn?.completed, true),
      25_000,
    );
    assert.ok(
      JSON.stringify(idleReply.request.input.input).includes(idlePrompt),
    );
    await waitForIdle();
    await restartWorker();
    assert.equal((await queue()).length, 0);
    const settled = (await call("GET", base, 200)).find(
      (row) => row.id === allowed,
    );
    assert.equal(settled.lastStatus, "queued");
    assert.equal(settled.nextRunAt, later);
    console.log(
      JSON.stringify({ suite: "native-project-automations", passed: true }),
    );
  }
}
