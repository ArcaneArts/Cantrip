// Actual Source/native helpers; controlled worker replies expose exact commands.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { projectLabel } from "./security-fixtures.mjs";
import { chatRelocationContextPayloadSchema } from "../../packages/protocol/src/chat-relocation.ts";
import { encodeCanonicalChatPayload } from "../../tests/reference-node-server/src/chats/hydration.ts";

const { values } = parseArgs({ options: { report: { type: "string" } } });
const root = await mkdtemp(path.join(tmpdir(), "cantrip-chat-hydration-"));
process.stderr.write(
  JSON.stringify({ event: "chat-hydration.fixture.created", root }) + "\n",
);
const report = {
  root,
  scope:
    "Actual helpers and native limited command bus with controlled worker replies; not production relocation actor or unchanged-worker acceptance",
  cases: [],
  completeReplacement: false,
};
const pair = [];
const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const beginType = "chat.relocation.hydration.begin";
const chunkType = "chat.relocation.hydration.chunk";
const completeType = "chat.relocation.hydration.complete";
const stamp = "2026-10-25T00:00:00.123Z";
const payload = (text) =>
  chatRelocationContextPayloadSchema.parse({
    version: 1,
    kind: "visible",
    messages:
      text === undefined
        ? []
        : [
            {
              sequence: 1,
              role: "user",
              mode: "default",
              content: [{ type: "text", text }],
              createdAt: stamp,
            },
          ],
    attachments: [],
  });
const opaque = (kind) =>
  chatRelocationContextPayloadSchema.parse({
    version: 1,
    kind,
    messages: [
      {
        id: "opaque-message",
        chatId: "chat",
        worktreeId: "worktree",
        executionLaneId: null,
        sequence: 1,
        role: "user",
        mode: "default",
        attachmentIds: [],
        protectedContent: projectLabel.protectedLabel,
        modelId: null,
        modelRouteId: null,
        providerId: null,
        providerName: null,
        providerModelName: null,
        reasoningEffort: null,
        appliedReasoningEffort: null,
        reasoningAdjusted: false,
        idempotencyKey: null,
        createdAt: stamp,
      },
    ],
    attachments: [],
  });
const input = (body = payload(), changes = {}) => ({
  chatId: "chat",
  snapshotId,
  workerId: "target",
  cwd: "/fixture/project",
  payload: body,
  permissionProfileId: "profile",
  planMode: "default",
  mcpServers: [],
  runtime: {
    model: { id: "model", name: "Fixture model" },
    provider: { id: "provider", kind: "chatgpt" },
  },
  ...changes,
});
const digest = (body) =>
  createHash("sha256").update(encodeCanonicalChatPayload(body)).digest("hex");
async function check(label, request, verify = () => {}) {
  const outcomes = [];
  const record = { label, request, outcomes };
  report.cases.push(record);
  for (const peer of pair) outcomes.push(await peer.request(request));
  for (const result of outcomes)
    assert.equal(result.rejected, false, label + ": " + result.diagnostic);
  assert.deepEqual(outcomes[1].value, outcomes[0].value, label);
  for (const { value: result } of outcomes) {
    if (request.op === "relocation-hydrate" && result.trace.length) {
      const bytes = encodeCanonicalChatPayload(request.input.payload);
      const begin = result.trace[0];
      assert.equal(begin.command.type, beginType);
      assert.equal(begin.command.sizeBytes, bytes.length);
      assert.equal(
        begin.command.transcriptSha256,
        digest(request.input.payload),
      );
      const chunks = result.trace.filter(
        (call) => call.command.type === chunkType,
      );
      for (const [index, call] of chunks.entries()) {
        assert.equal(call.command.chunkIndex, index);
        assert.equal(call.command.snapshotId, snapshotId);
        assert.deepEqual(
          Buffer.from(call.command.data, "base64"),
          bytes.subarray(index * 262144, (index + 1) * 262144),
        );
      }
      for (const call of result.trace) {
        assert.equal(call.worker, request.input.workerId);
        assert.deepEqual(call.options, {
          timeoutMs: call.command.type === completeType ? 1800000 : 30000,
        });
      }
      if (
        result.error === null &&
        request.responses?.[beginType]?.status !== "hydrated"
      ) {
        assert.equal(chunks.length, Math.ceil(bytes.length / 262144));
        assert.deepEqual(
          Buffer.concat(
            chunks.map((call) => Buffer.from(call.command.data, "base64")),
          ),
          bytes,
        );
        assert.equal(result.trace.at(-1).command.type, completeType);
        assert.deepEqual(result.value, {
          threadId: "hydrated-thread",
          transcriptSha256: digest(request.input.payload),
        });
      }
    }
    verify(result);
  }
  return outcomes.map((result) => result.value);
}
const success = (result) => assert.equal(result.error, null);
const noRequests = (code) => (result) => {
  assert.equal(result.error.code, code);
  assert.equal(result.value, null);
  assert.deepEqual(result.trace, []);
};
try {
  const executable = await buildRustExample("project-repository-fixture");
  for (const kind of ["node", "rust"])
    pair.push(
      await repositoryFixture({
        kind,
        executable,
        root,
        databaseMode: "pglite",
      }),
    );
  await check(
    "empty visible transcript",
    { op: "relocation-hydrate", input: input() },
    success,
  );
  await check(
    "opaque runtime configuration and UTF16 values are preserved",
    {
      op: "relocation-hydrate",
      input: input(payload("Configuration $skill"), {
        chatId: "chat-😀",
        workerId: "target-Δ",
        cwd: "/fixture/😀/\ud800",
        permissionProfileId: "permission-\ud800",
        planMode: "goal",
        runtime: {
          routeId: "route",
          model: {
            id: "model",
            profileName: "Profile-\ud800",
            name: "native-model",
            routeId: "route",
            reasoningEffort: null,
            providerModelId: null,
            catalog: null,
          },
          provider: {
            id: "provider",
            name: "Provider",
            kind: "chatgpt",
            baseUrl: "https://example.invalid",
            protectedApiKey: null,
            accountId: "preferred-account",
            credentialHomeKey: "opaque-home",
            weeklyUsageReservePercent: 7,
            maxConcurrentInference: null,
            inferenceConfigRevision: 1,
            inferenceCatalogCreatedRevision: 1,
          },
        },
        mcpServers: [
          {
            id: "mcp",
            enabled: true,
            nameBlindIndex: "opaque-name",
            protectedConfiguration: projectLabel.protectedLabel,
          },
        ],
      }),
    },
    success,
  );
  const skillText =
    "$z $A $_ignored $$ignored embedded$ignored $a.name $a:name $a-name $9 $A $z\n😀$unicodeBoundary \ud800$surrogateBoundary";
  await check(
    "skill boundaries and stable ASCII ordering",
    { op: "relocation-skills", payload: payload(skillText) },
    (result) => {
      success(result);
      assert.deepEqual(result.value, [
        "9",
        "A",
        "a-name",
        "a.name",
        "a:name",
        "surrogateBoundary",
        "unicodeBoundary",
        "z",
      ]);
    },
  );
  const sixtyFour = payload(
    Array.from({ length: 64 }, (_, i) => "$skill" + i).join(" "),
  );
  const sixtyFive = payload(
    Array.from({ length: 65 }, (_, i) => "$skill" + i).join(" "),
  );
  await check(
    "64 unique skills accepted",
    { op: "relocation-hydrate", input: input(sixtyFour) },
    (result) => {
      success(result);
      assert.equal(result.trace[0].command.requiredSkillNames.length, 64);
    },
  );
  await check(
    "duplicates do not consume skill budget",
    {
      op: "relocation-skills",
      payload: payload(
        (
          Array.from({ length: 64 }, (_, i) => "$skill" + i).join(" ") + " "
        ).repeat(3),
      ),
    },
    (result) => {
      success(result);
      assert.equal(result.value.length, 64);
    },
  );
  await check(
    "65 skills rejected before worker dispatch",
    { op: "relocation-hydrate", input: input(sixtyFive) },
    noRequests("too-many-skills"),
  );
  await check(
    "digest check precedes skill extraction",
    {
      op: "relocation-hydrate",
      input: input(sixtyFive, { expectedSha256: "0".repeat(64) }),
    },
    noRequests("digest-mismatch"),
  );
  for (const kind of ["chat-encrypted", "task-encrypted"])
    await check(
      "opaque " + kind + " remains opaque",
      { op: "relocation-hydrate", input: input(opaque(kind)) },
      (result) => {
        success(result);
        assert.deepEqual(result.trace[0].command.requiredSkillNames, []);
      },
    );
  const body = payload("Boundary $test 😀");
  await check(
    "correct expected digest accepted",
    {
      op: "relocation-hydrate",
      input: input(body, { expectedSha256: digest(body) }),
    },
    success,
  );
  await check(
    "empty expected digest preserves Source truthiness",
    { op: "relocation-hydrate", input: input(body, { expectedSha256: "" }) },
    success,
  );
  await check(
    "wrong expected digest rejected before dispatch",
    {
      op: "relocation-hydrate",
      input: input(body, { expectedSha256: "f".repeat(64) }),
    },
    noRequests("digest-mismatch"),
  );
  await check(
    "already hydrated runtime reused",
    {
      op: "relocation-hydrate",
      input: input(body),
      responses: {
        [beginType]: {
          status: "hydrated",
          threadId: "existing-thread",
          ignored: true,
        },
      },
    },
    (result) => {
      success(result);
      assert.equal(result.trace.length, 1);
      assert.equal(result.value.threadId, "existing-thread");
    },
  );
  await check(
    "reused thread retains lone surrogate",
    {
      op: "relocation-hydrate",
      input: input(body),
      responses: { [beginType]: { status: "hydrated", threadId: "\ud800" } },
    },
    (result) => {
      success(result);
      assert.equal(result.value.threadId, "\ud800");
      assert.equal(result.trace.length, 1);
    },
  );
  for (const omitResponse of [beginType, completeType])
    await check(
      "missing worker reply " + omitResponse,
      { op: "relocation-hydrate", input: input(body), omitResponse },
      (result) => {
        assert.ok(result.error?.message);
        assert.equal(result.trace.at(-1).command.type, omitResponse);
      },
    );
  await check(
    "missing chunk acknowledgment is accepted",
    { op: "relocation-hydrate", input: input(body), omitResponse: chunkType },
    success,
  );
  for (const reply of [
    null,
    { status: "unknown" },
    { status: "hydrated", threadId: "" },
  ])
    await check(
      "invalid begin response " + JSON.stringify(reply),
      {
        op: "relocation-hydrate",
        input: input(body),
        responses: { [beginType]: reply },
      },
      (result) => {
        assert.ok(result.error?.message);
        assert.equal(result.trace.length, 1);
      },
    );
  const baseLength = encodeCanonicalChatPayload(payload("x")).length;
  for (const delta of [-1, 0, 1]) {
    const boundary = payload("x".repeat(262144 - baseLength + 1 + delta));
    assert.equal(encodeCanonicalChatPayload(boundary).length, 262144 + delta);
    await check(
      "byte chunk boundary " + delta,
      { op: "relocation-hydrate", input: input(boundary) },
      success,
    );
  }
  const unicode = payload("😀\ue000\ud800\u2028\u2029".repeat(21000));
  await check(
    "UTF16 and UTF8 cross-chunk bytes",
    { op: "relocation-hydrate", input: input(unicode) },
    success,
  );
  await check(
    "chunk replies are intentionally opaque",
    {
      op: "relocation-hydrate",
      input: input(body),
      responses: { [chunkType]: { unrelated: "ignored" } },
    },
    success,
  );
  for (const failCommand of [beginType, chunkType, completeType])
    await check(
      "worker failure propagated at " + failCommand,
      { op: "relocation-hydrate", input: input(body), failCommand },
      (result) => {
        assert.deepEqual(result.error, {
          code: null,
          message: "Controlled hydration worker failure",
        });
        assert.equal(result.trace.at(-1).command.type, failCommand);
      },
    );
  await check(
    "partial multi-chunk failure stops upload",
    {
      op: "relocation-hydrate",
      input: input(payload("x".repeat(600000))),
      failCommand: chunkType,
      failChunkIndex: 1,
    },
    (result) => {
      assert.equal(result.error.message, "Controlled hydration worker failure");
      assert.equal(result.trace.length, 3);
      assert.equal(result.trace.at(-1).command.chunkIndex, 1);
    },
  );
  const complete = {
    snapshotId,
    transcriptSha256: digest(body),
    threadId: "hydrated-thread",
    reused: false,
  };
  for (const changes of [
    { snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { transcriptSha256: "f".repeat(64) },
  ])
    await check(
      "different target snapshot or digest " + JSON.stringify(changes),
      {
        op: "relocation-hydrate",
        input: input(body),
        responses: { [completeType]: { ...complete, ...changes } },
      },
      (result) => assert.equal(result.error.code, "target-mismatch"),
    );
  await check(
    "invalid completion response",
    {
      op: "relocation-hydrate",
      input: input(body),
      responses: { [completeType]: { snapshotId, threadId: "" } },
    },
    (result) => assert.ok(result.error?.message),
  );
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  report.diagnostics = pair.map((peer) => peer.diagnostics());
  const shutdown = await Promise.allSettled(pair.map((peer) => peer.close()));
  report.shutdown = shutdown.map((result) =>
    result.status === "fulfilled"
      ? { status: "fulfilled" }
      : {
          status: "rejected",
          error: result.reason.stack ?? String(result.reason),
        },
  );
  const shutdownError = shutdown.find((result) => result.status === "rejected");
  if (shutdownError) report.passed = false;
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
  if (shutdownError && !report.failure) throw shutdownError.reason;
}
console.log(
  JSON.stringify({ root, passed: report.passed, cases: report.cases.length }),
);
