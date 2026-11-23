import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import {
  modelFunctions,
  taskModelProvider,
} from "../server-rust/task-model-provider.mjs";

export async function verifyProjectExport({
  call,
  eventually,
  projectId,
  workerId,
  workerDirectory,
  userHome,
  codexHome,
  master,
  ownerId,
  restartWorker,
  checkout,
  registerMetadata,
}) {
  const list = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(list.status, 200, JSON.stringify(list));
  const worktree = list.body.find(
    (tree) => tree.isPrimary && tree.workerId === workerId,
  );
  assert.ok(worktree, JSON.stringify(list));
  const identity = JSON.parse(
    await readFile(
      path.join(workerDirectory, "worker-encryption-key.json"),
      "utf8",
    ),
  );
  async function grant(component) {
    const componentKey = crypto.deriveComponentKey({
      accountMasterKey: master,
      ownerId,
      component,
      keyRevision: 1,
    });
    const wrappedKey = await crypto.wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component,
      keyRevision: 1,
      componentKey,
      workerPublicKey: identity.publicKey,
    });
    const granted = await call(
      "POST",
      `/api/encryption/principals/${identity.principalId}/grants`,
      {
        component,
        keyRevision: 1,
        wrappedKey,
      },
    );
    assert.equal(granted.status, 201, JSON.stringify(granted));
    const refreshed = await call(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      {
        component,
        keyRevision: 1,
      },
    );
    assert.equal(
      refreshed.body.status.state,
      "ready",
      JSON.stringify(refreshed),
    );
    return componentKey;
  }
  const labelKey = await grant("private-surface-metadata");
  const chatKey = await grant("chat-content");
  const mediaKey = await grant("attachment-content");
  const providerKey = await grant("provider-credential");
  const upstream = await taskModelProvider();
  try {
    const chatId = randomUUID();
    const title = "Private exported fixture";
    const endpoint = `/api/projects/${projectId}`;
    const created = await call("POST", endpoint + "/chats", {
      id: chatId,
      autoTitle: false,
      titleProtection: await crypto.encryptPrivateDisplayLabel({
        ownerId,
        keyRevision: 1,
        recordKind: "chat",
        rowId: chatId,
        componentKey: labelKey,
        label: title,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const messages = `/api/chats/${chatId}/messages`;
    async function append(role, text) {
      const messageId = randomUUID();
      const classification = { role, mode: "default", attachmentIds: [] };
      const response = await call("POST", messages, {
        id: messageId,
        idempotencyKey: randomUUID(),
        classification,
        reasoningEffort: null,
        protectedContent: await crypto.encryptChatMessageProtectedContent({
          ownerId,
          messageId,
          keyRevision: 1,
          componentKey: chatKey,
          content: {
            version: 1,
            classification,
            content: [{ type: "text", text }],
          },
        }),
      });
      assert.equal(response.status, 201, JSON.stringify(response));
    }
    const input = "Private export fixture question 🌲";
    const output = "Private export fixture answer";
    await append("user", input);
    // The encrypted message exceeds one 256 KiB worker command chunk.
    const largeAnswer = `${output}\n${"bounded export evidence\n".repeat(9_000)}end of fixture answer`;
    await append("assistant", largeAnswer);
    const before = await call("GET", messages);
    assert.equal(before.status, 200);
    const target = { kind: "codex-local" };
    const worktreeId = worktree.id;
    const preview = await call("POST", endpoint + "/exports/preview", {
      target,
      worktreeId,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.body.available, true, JSON.stringify(preview));
    assert.equal(preview.body.destinationLabel, "$CODEX_HOME");
    const operationId = randomUUID();
    const request = { operationId, target, worktreeId, chatIds: [chatId] };
    async function exportChat() {
      const response = await call("POST", endpoint + "/exports", request);
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.body.outcomes.length, 1);
      assert.equal(JSON.stringify(response.body).includes(checkout), false);
      assert.equal(JSON.stringify(response.body).includes(input), false);
      return response.body.outcomes[0];
    }
    const first = await exportChat();
    assert.equal(first.status, "exported", JSON.stringify(first));
    assert.equal(first.reused, false);
    assert.equal(first.messageCount, 2);
    const leaf = createHash("sha256").update(chatId).digest("hex");
    const journal = path.join(
      workerDirectory,
      "project-exports",
      operationId,
      leaf,
    );
    const receiptText = await readFile(
      path.join(journal, "state.json"),
      "utf8",
    );
    assert.equal(JSON.parse(receiptText).threadId, first.threadId);
    assert.equal(JSON.parse(receiptText).status, "exported");
    assert.ok(!receiptText.includes(title) && !receiptText.includes(input));
    await assert.rejects(lstat(path.join(journal, "transcript.uploading")), {
      code: "ENOENT",
    });
    await assert.rejects(
      lstat(path.join(userHome, ".cursor", "projects", ".cantrip-exports")),
      { code: "ENOENT" },
    );
    const sessions = path.join(codexHome, "sessions");
    const artifacts = (await readdir(sessions, { recursive: true })).filter(
      (name) => name.endsWith(".jsonl"),
    );
    assert.equal(artifacts.length, 1);
    const transcript = await readFile(
      path.join(sessions, artifacts[0]),
      "utf8",
    );
    assert.ok(
      transcript.includes(input) &&
        transcript.includes(output) &&
        transcript.includes("end of fixture answer"),
    );
    assert.deepEqual(await call("GET", messages), before);
    await restartWorker();
    const replay = await exportChat();
    assert.deepEqual(replay, { ...first, reused: true });
    await append("user", "A later message changes the export identity");
    const conflict = await exportChat();
    assert.equal(conflict.status, "failed", JSON.stringify(conflict));
    assert.match(conflict.message, /associated with different source data/u);
    assert.deepEqual(
      (await readdir(sessions, { recursive: true })).filter((name) =>
        name.endsWith(".jsonl"),
      ),
      artifacts,
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=",
      "base64",
    );
    const picture = path.join(checkout, "fixture-image.png");
    await writeFile(picture, png);
    // Add a genuine local-image event to the owned external rollout. The
    // bundled Codex app-server still reads and projects the source session.
    const records = transcript
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const userMessage = records.find(
      (row) => row.type === "event_msg" && row.payload.type === "user_message",
    );
    assert.ok(userMessage, "The native rollout contains a user message.");
    userMessage.payload.local_images = [picture];
    await writeFile(
      path.join(sessions, artifacts[0]),
      records.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );

    const discovery = await call(
      "GET",
      endpoint + "/external-chat-history?includeArchived=true",
    );
    assert.equal(discovery.status, 200, JSON.stringify(discovery));
    const sourceWorker = discovery.body.workers.find(
      (worker) => worker.workerId === workerId,
    );
    assert.equal(sourceWorker?.status, "ok", JSON.stringify(discovery));
    const source = sourceWorker.sources.find(
      (source) => source.homeLabel === "$CODEX_HOME",
    );
    assert.equal(
      source?.availability,
      "available",
      JSON.stringify(sourceWorker),
    );
    const candidate = source.threads.find(
      (thread) => thread.sourceThreadId === first.threadId,
    );
    assert.equal(candidate?.title, title);
    assert.equal(candidate.match.worktreeId, worktreeId);
    const provider = await call("POST", "/api/settings/providers", {
      id: randomUUID(),
      kind: "openai-compatible",
      name: "Imported chat continuation fixture",
      baseUrl: upstream.baseUrl,
      initialAccount: null,
      protectedApiKey: null,
      maxConcurrentInference: 1,
    });
    assert.equal(provider.status, 201, JSON.stringify(provider));
    const model = await call("POST", "/api/settings/models", {
      name: "Imported chat fixture model",
      routes: [
        {
          providerId: provider.body.id,
          modelName: upstream.model,
          enabled: true,
        },
      ],
    });
    assert.equal(model.status, 201, JSON.stringify(model));
    const imported = await call("POST", endpoint + "/chat-imports", {
      imports: [
        {
          sourceKind: source.kind,
          sourceWorkerId: workerId,
          sourceId: source.sourceId,
          sourceThreadId: candidate.sourceThreadId,
          idempotencyKey: randomUUID(),
          target: { kind: "worktree", projectId, worktreeId },
          modelId: model.body.id,
        },
      ],
    });
    assert.equal(imported.status, 202, JSON.stringify(imported));
    const jobId = imported.body[0].id;
    const { body: job } = await eventually(
      () => call("GET", `/api/chat-imports/${jobId}`),
      (value) => {
        assert.equal(value.status, 200, JSON.stringify(value));
        assert.ok(
          ["succeeded", "failed", "blocked"].includes(value.body.state),
          JSON.stringify(value),
        );
      },
      "native external import settled",
    );
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    if (!job.managedThreadId) {
      const workers = await call("GET", "/api/workers");
      const runtime = workers.body.find(
        (worker) => worker.workerId === workerId,
      )?.codexRuntime;
      assert.fail(
        `Import completed without a native thread. Runtime ${JSON.stringify(runtime)}`,
      );
    }
    assert.equal(job.attachmentCount, 1);
    assert.equal(job.attachmentWarningCount, 0);
    const importedMessages = await call(
      "GET",
      `/api/chats/${job.chatId}/messages`,
    );
    assert.equal(importedMessages.status, 200);
    function openMessage(message) {
      return crypto.decryptChatMessageProtectedContent({
        ownerId,
        messageId: message.id,
        componentKey: chatKey,
        keyRevision: 1,
        publicClassification: message.classification ?? {
          role: message.role,
          mode: message.mode,
          attachmentIds: message.attachmentIds,
        },
        encrypted: message.protectedContent,
      });
    }
    const history = await Promise.all(
      importedMessages.body.messages.map(openMessage),
    );
    const user = history.find(
      (message) =>
        message.classification.role === "user" &&
        message.content.some(
          (item) => item.type === "text" && item.text === input,
        ),
    );
    assert.ok(user, "The canonical history contains the imported question.");
    const assistant = history.find(
      (message) =>
        message.classification.role === "assistant" &&
        message.content.some(
          (item) => item.type === "text" && item.text === largeAnswer,
        ),
    );
    assert.ok(assistant, "The canonical history contains the imported answer.");
    assert.ok(
      history.some((message) =>
        message.content.some(
          (item) =>
            item.type === "activity" && item.activity.type === "turnSummary",
        ),
      ),
      "The canonical history retains the turn summary.",
    );
    assert.equal(user.classification.attachmentIds.length, 1);
    const [attachmentId] = user.classification.attachmentIds;
    const destination = path.join(
      workerDirectory,
      "attachments",
      job.chatId,
      attachmentId,
      "fixture-image.png",
    );
    assert.deepEqual(await readFile(destination), png);
    await restartWorker();
    const downloadId = randomUUID();
    const download = await call(
      "GET",
      `/api/attachments/${attachmentId}/content?operationId=${downloadId}`,
    );
    assert.equal(download.status, 200, JSON.stringify(download));
    assert.equal(download.body.chunks.length, 1);
    const [encrypted] = download.body.chunks;
    assert.ok(encrypted.eof);
    assert.deepEqual(
      Buffer.from(
        await crypto.decryptAttachmentChunk({
          ownerId,
          chatId: job.chatId,
          attachmentId,
          operationId: downloadId,
          direction: "download",
          sequence: 0,
          keyRevision: 1,
          componentKey: mediaKey,
          encrypted,
        }),
      ),
      png,
    );
    const sourceStage = path.join(
      workerDirectory,
      "external-chat-imports",
      source.sourceId,
      createHash("sha256").update(first.threadId).digest("hex"),
    );
    await assert.rejects(lstat(sourceStage), { code: "ENOENT" });
    const hydrationReceipt = JSON.parse(
      await readFile(
        path.join(workerDirectory, "chat-relocations", jobId, "state.json"),
        "utf8",
      ),
    );
    assert.equal(hydrationReceipt.threadId, job.managedThreadId);
    assert.equal(hydrationReceipt.status, "hydrated");
    await assert.rejects(
      lstat(
        path.join(
          workerDirectory,
          "chat-relocations",
          jobId,
          "context.uploading",
        ),
      ),
      { code: "ENOENT" },
    );
    const question = "Continue the imported conversation 🌲";
    const reply = upstream.reply({
      text: "Continuation from the imported history",
    });
    const next = await encryptedTurn({
      ownerId,
      chatKey,
      modelId: model.body.id,
      question,
    });
    const submitted = await call(
      "POST",
      `/api/chats/${job.chatId}/turns`,
      next,
    );
    assert.equal(submitted.status, 202, JSON.stringify(submitted));
    await eventually(
      () => Promise.resolve(reply),
      (turn) => {
        assert.equal(turn.request?.completed, true);
      },
      "imported native conversation resumes after worker restart",
    );
    const context = JSON.stringify(reply.request.input.input);
    assert.ok(context.includes(input));
    assert.ok(context.includes("end of fixture answer"));
    assert.ok(context.includes(question));
    assert.deepEqual(upstream.failures, []);

    const importedMessagesUrl = `/api/chats/${job.chatId}/messages`;
    async function verifyAnswer(answer) {
      await eventually(
        async () => {
          const [messages, chats] = await Promise.all([
            call("GET", importedMessagesUrl),
            call("GET", endpoint + "/chats"),
          ]);
          assert.equal(messages.status, 200);
          assert.equal(chats.status, 200);
          return {
            status: chats.body.find((chat) => chat.id === job.chatId)?.status,
            history: await Promise.all(messages.body.messages.map(openMessage)),
          };
        },
        ({ status, history }) => {
          assert.equal(status, "idle");
          assert.ok(
            history.some((message) =>
              message.content.some(
                (item) => item.type === "text" && item.text === answer,
              ),
            ),
          );
        },
        "native continuation committed protected output",
      );
    }
    await verifyAnswer("Continuation from the imported history");

    // Relocation requires clean source and destination worktrees at the
    // admitted revision. Remove the two files created by this owned fixture.
    await unlink(picture);
    await unlink(path.join(checkout, "untouched.txt"));
    const names = await registerMetadata(projectId, {
      name: "Hydration destination",
      branch: "chat-relocation-fixture",
    });
    const newWorktree = await call("POST", endpoint + "/worktrees", {
      name: names.name,
      mode: { type: "newBranch", branch: names.branch, startPoint: null },
      sourceWorktreeId: worktreeId,
    });
    assert.equal(newWorktree.status, 201, JSON.stringify(newWorktree));
    const queued = await call("POST", `/api/chats/${job.chatId}/relocations`, {
      target: { kind: "worktree", projectId, worktreeId: newWorktree.body.id },
      approved: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(queued.status, 202, JSON.stringify(queued));
    const { body: relocated } = await eventually(
      () => call("GET", `/api/chat-relocations/${queued.body.id}`),
      (value) => {
        assert.equal(value.status, 200, JSON.stringify(value));
        assert.ok(
          ["succeeded", "blocked", "failed"].includes(value.body.state),
          JSON.stringify(value.body),
        );
      },
      "native protected chat relocation settled",
    );
    assert.equal(relocated.state, "succeeded", JSON.stringify(relocated));
    assert.equal(relocated.targetPlacement.worktreeId, newWorktree.body.id);
    assert.notEqual(relocated.targetRuntimeThreadId, job.managedThreadId);
    await eventually(
      () => call("GET", `/api/workers/${workerId}/logs?limit=500`),
      (value) => {
        assert.equal(value.status, 200);
        assert.ok(
          value.body.records.some(
            (record) =>
              record.context?.operation === "chat.relocation.thread.release" &&
              record.context.event === "worker.command.completed",
          ),
        );
      },
      "source managed thread released after placement commit",
    );
    const nextQuestion = "Continue the relocated conversation";
    const nextAnswer = "Continuation from the relocated history";
    const relocatedReply = upstream.reply({ text: nextAnswer });
    const original = await encryptedTurn({
      ownerId,
      chatKey,
      modelId: model.body.id,
      question: nextQuestion,
    });
    const relocatedTurn = await call(
      "POST",
      `/api/chats/${job.chatId}/turns`,
      original,
    );
    assert.equal(relocatedTurn.status, 202, JSON.stringify(relocatedTurn));
    await verifyAnswer(nextAnswer);
    const relocatedContext = JSON.stringify(relocatedReply.request.input.input);
    assert.ok(relocatedContext.includes("end of fixture answer"));
    assert.ok(
      relocatedContext.includes("Continuation from the imported history"),
    );
    assert.ok(relocatedContext.includes(nextQuestion));

    await restartWorker();
    const editedQuestion = "Replace the last relocated prompt after restart";
    const editedAnswer = "Answer to the edited relocated prompt";
    const edited = await encryptedTurn({
      ownerId,
      chatKey,
      modelId: model.body.id,
      question: editedQuestion,
    });
    const editUrl = (id) => `/api/chats/${job.chatId}/turns/${id}/retry`;
    const stale = await call("POST", editUrl(next.message.id), edited);
    assert.equal(stale.status, 409, JSON.stringify(stale));
    assert.match(stale.body.error, /latest user message/u);
    const editedReply = upstream.reply({ text: editedAnswer });
    const retry = await call("POST", editUrl(original.message.id), edited);
    assert.equal(retry.status, 202, JSON.stringify(retry));
    assert.equal(retry.body.message.id, edited.message.id);
    try {
      await verifyAnswer(editedAnswer);
    } catch (cause) {
      const logs = await call(
        "GET",
        `/api/workers/${workerId}/logs?limit=500&minimumLevel=warn`,
      );
      throw new Error(
        `Edited turn did not commit. Provider entered=${Boolean(editedReply.request)}. Worker logs ${JSON.stringify(logs.body.records?.slice(-15))}`,
        { cause },
      );
    }
    const editedContext = JSON.stringify(editedReply.request.input.input);
    assert.ok(editedContext.includes("Continuation from the imported history"));
    assert.ok(editedContext.includes(editedQuestion));
    assert.ok(!editedContext.includes(nextQuestion));
    assert.ok(!editedContext.includes(nextAnswer));
    const afterEdit = await call("GET", importedMessagesUrl);
    assert.equal(afterEdit.status, 200);
    assert.ok(
      !afterEdit.body.messages.some(
        (message) => message.id === original.message.id,
      ),
    );
    const openedAfterEdit = await Promise.all(
      afterEdit.body.messages.map(openMessage),
    );
    const textAfterEdit = JSON.stringify(openedAfterEdit);
    assert.ok(!textAfterEdit.includes(nextQuestion));
    assert.ok(!textAfterEdit.includes(nextAnswer));
    assert.ok(textAfterEdit.includes(editedAnswer));
    const replayedEdit = await call(
      "POST",
      editUrl(original.message.id),
      edited,
    );
    assert.equal(replayedEdit.status, 200, JSON.stringify(replayedEdit));
    assert.equal(replayedEdit.body.message.id, edited.message.id);
    const afterReplay = await call("GET", importedMessagesUrl);
    assert.equal(afterReplay.status, 200);
    assert.deepEqual(
      afterReplay.body.messages.map(({ id, role }) => ({ id, role })),
      afterEdit.body.messages.map(({ id, role }) => ({ id, role })),
    );
    const replayedHistory = await Promise.all(
      afterReplay.body.messages.map(openMessage),
    );
    assert.equal(
      replayedHistory.filter((message) =>
        message.content.some(
          (item) => item.type === "text" && item.text === editedAnswer,
        ),
      ).length,
      1,
    );

    const followupQuestion = "Continue after the edited prompt";
    const followupAnswer = "Answer after the edited prompt";
    const followup = upstream.reply({ text: followupAnswer });
    const followupTurn = await call(
      "POST",
      `/api/chats/${job.chatId}/turns`,
      await encryptedTurn({
        ownerId,
        chatKey,
        modelId: model.body.id,
        question: followupQuestion,
      }),
    );
    assert.equal(followupTurn.status, 202, JSON.stringify(followupTurn));
    await verifyAnswer(followupAnswer);
    const followupContext = JSON.stringify(followup.request.input.input);
    assert.ok(followupContext.includes(editedQuestion));
    assert.ok(followupContext.includes(editedAnswer));
    assert.ok(!followupContext.includes(nextQuestion));

    const summary = "Preserve this summary of the edited conversation";
    const compacted = upstream.reply({ text: summary, hold: true });
    const compactUrl = `/api/chats/${job.chatId}/compact`;
    const compact = await call("POST", compactUrl, {});
    assert.deepEqual(compact, { status: 200, body: { accepted: true } });
    try {
      await eventually(
        async () => compacted.request,
        (request) => {
          assert.ok(request, JSON.stringify(upstream.failures));
          assert.ok(!request.completed);
          assert.ok(JSON.stringify(request.input).includes(followupAnswer));
        },
        "native compaction begins after public acknowledgement",
      );
      const concurrent = await call("POST", compactUrl, {});
      assert.equal(concurrent.status, 409, JSON.stringify(concurrent));
    } finally {
      compacted.release();
    }
    await verifyAnswer(followupAnswer);
    assert.equal(compacted.request.completed, true);

    await restartWorker();
    const afterCompactionQuestion = "Continue after native compaction";
    const afterCompactionAnswer = "Native compaction retained the thread";
    const afterCompaction = upstream.reply({ text: afterCompactionAnswer });
    const continued = await call(
      "POST",
      `/api/chats/${job.chatId}/turns`,
      await encryptedTurn({
        ownerId,
        chatKey,
        modelId: model.body.id,
        question: afterCompactionQuestion,
      }),
    );
    assert.equal(continued.status, 202, JSON.stringify(continued));
    await verifyAnswer(afterCompactionAnswer);
    const compactedContext = JSON.stringify(
      afterCompaction.request.input.input,
    );
    assert.ok(compactedContext.includes(summary));
    assert.ok(compactedContext.includes(afterCompactionQuestion));

    const interrupted = upstream.reply({ hold: true });
    assert.deepEqual(await call("POST", compactUrl, {}), compact);
    try {
      await eventually(
        async () => interrupted.entered,
        (entered) => assert.ok(entered),
        "a native compaction is ready to interrupt",
      );
      const stop = await call("POST", `/api/chats/${job.chatId}/interrupt`, {});
      assert.deepEqual(stop, { status: 200, body: { interrupted: true } });
      await verifyAnswer(afterCompactionAnswer);
    } finally {
      interrupted.release();
    }

    const retryCompaction = upstream.reply({ text: "Summary after Stop" });
    assert.deepEqual(await call("POST", compactUrl, {}), compact);
    await eventually(
      async () => retryCompaction.request,
      (request) => assert.equal(request?.completed, true),
      "a new compaction enters inference after Stop",
    );
    await verifyAnswer(afterCompactionAnswer);

    function advertisedTool(record, tool) {
      return modelFunctions([
        ...record.input.tools,
        ...record.input.input
          .filter((item) => item.type === "tool_search_output")
          .flatMap((item) => item.tools ?? []),
      ]).find(({ name }) => name === tool || name.endsWith("__" + tool));
    }
    const agentAnswer = "The agent scheduled context compaction";
    const agentSummary = "Keep the context summary scheduled by the agent";
    upstream.reply({ toolSearch: { query: "context_get" } });
    const contextCall = upstream.reply({ hold: true });
    const contextResult = upstream.reply({
      toolSearch: { query: "context_compact" },
    });
    const scheduling = upstream.reply({ hold: true });
    const repeatScheduling = upstream.reply({ hold: true });
    const scheduleResult = upstream.reply({ text: agentAnswer, hold: true });
    const deferredCompaction = upstream.reply({ text: agentSummary });
    try {
      const turn = await call(
        "POST",
        `/api/chats/${job.chatId}/turns`,
        await encryptedTurn({
          ownerId,
          chatKey,
          modelId: model.body.id,
          question: "Inspect and schedule Codex context compaction",
        }),
      );
      assert.equal(turn.status, 202, JSON.stringify(turn));
      await eventually(
        async () => contextCall.request,
        (record) => assert.ok(record),
        "Codex discovers context_get",
      );
      const contextTool = advertisedTool(contextCall.request, "context_get");
      assert.ok(contextTool);
      contextCall.calls = [{ ...contextTool, arguments: {} }];
      contextCall.release();
      await eventually(
        async () => scheduling.request,
        (record) => assert.ok(record),
        "Codex discovers context_compact",
      );
      const contextOutput = contextResult.request.input.input.find(
        (item) =>
          item.type === "function_call_output" &&
          JSON.stringify(item.output).includes("contextWindow"),
      );
      assert.equal(typeof contextOutput?.output, "string");
      assert.match(contextOutput.output, /"usedTokens":120/u);
      assert.match(contextOutput.output, /"compactionScheduled":false/u);
      const compactTool = advertisedTool(scheduling.request, "context_compact");
      assert.ok(compactTool);
      scheduling.calls = [{ ...compactTool, arguments: {} }];
      scheduling.release();
      await eventually(
        async () => repeatScheduling.request,
        (record) => assert.ok(record),
        "Codex receives the first scheduling result",
      );
      const scheduled = (record) =>
        record.input.input.filter(
          (item) =>
            item.type === "function_call_output" &&
            typeof item.output === "string" &&
            item.output.includes('"compactionScheduled":true'),
        );
      const firstSchedule = scheduled(repeatScheduling.request).at(-1);
      assert.ok(
        firstSchedule,
        JSON.stringify(
          repeatScheduling.request.input.input
            .filter(({ type }) => type === "function_call_output")
            .slice(-2),
        ),
      );
      // A second call in the same turn still schedules only one follow-up.
      repeatScheduling.calls = [{ ...compactTool, arguments: {} }];
      repeatScheduling.release();
      await eventually(
        async () => scheduleResult.request,
        (record) => assert.ok(record),
        "Codex receives the repeated scheduling result",
      );
      assert.ok(
        scheduled(scheduleResult.request).some(
          ({ call_id }) => call_id !== firstSchedule.call_id,
        ),
        JSON.stringify(
          scheduleResult.request.input.input
            .filter(({ type }) => type === "function_call_output")
            .slice(-3),
        ),
      );
      assert.ok(!deferredCompaction.entered);
    } finally {
      contextCall.release();
      scheduling.release();
      repeatScheduling.release();
      scheduleResult.release();
    }
    await eventually(
      async () => deferredCompaction.request,
      (request) => assert.equal(request?.completed, true),
      "the scheduled compaction runs after the tool's turn",
    );
    await verifyAnswer(agentAnswer);
    const final = upstream.reply({ text: "The agent summary carries forward" });
    const nextTurn = await call(
      "POST",
      `/api/chats/${job.chatId}/turns`,
      await encryptedTurn({
        ownerId,
        chatKey,
        modelId: model.body.id,
        question: "Continue after the agent's compaction",
      }),
    );
    assert.equal(nextTurn.status, 202, JSON.stringify(nextTurn));
    await verifyAnswer("The agent summary carries forward");
    assert.ok(JSON.stringify(final.request.input.input).includes(agentSummary));
    assert.deepEqual(upstream.failures, []);
  } finally {
    labelKey.fill(0);
    chatKey.fill(0);
    mediaKey.fill(0);
    providerKey.fill(0);
    await upstream.close();
  }
}

async function encryptedTurn({ ownerId, chatKey, modelId, question }) {
  const common = { ownerId, keyRevision: 1, componentKey: chatKey };
  const messageId = randomUUID();
  const promptId = randomUUID();
  const idempotencyKey = randomUUID();
  const classification = { mode: "default", attachmentIds: [] };
  const messageClassification = { ...classification, role: "user" };
  const message = {
    id: messageId,
    idempotencyKey,
    classification: messageClassification,
    reasoningEffort: null,
    protectedContent: await crypto.encryptChatMessageProtectedContent({
      ...common,
      messageId,
      content: {
        version: 1,
        classification: messageClassification,
        content: [{ type: "text", text: question }],
      },
    }),
  };
  return {
    modelId,
    message,
    queuedPrompt: {
      id: promptId,
      idempotencyKey,
      modelId,
      classification,
      reasoningEffort: null,
      frozen: false,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
      worktreeId: null,
      pendingMessage: message,
      protectedContent: await crypto.encryptQueuedPromptProtectedContent({
        ...common,
        promptId,
        content: { version: 1, classification, text: question },
      }),
    },
  };
}
